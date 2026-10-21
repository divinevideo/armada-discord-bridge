import type postgres from "postgres";
import type { NostrEvent } from "nostr-tools/pure";
import type { RelayPool } from "../../bridge/src/concord/pool";
import type { ConcordActions, PublicationMetadata } from "./concordActions";
import type { Decisions, DeliveryClaim, StoredDecision, VerifiedCoopActor } from "./decisions";
import { EvidenceCipher } from "./evidence";
import { lockLifecycleDecision } from "./lifecycle";
import { deliverConcord } from "./concordDelivery";
import { RetryableDeliveryError } from "./discordActions";
import { verifiedEvent } from "./relayPolicy";

const uncertain = `(d.target = 'concord' AND c.action IN ('ban_member','unban_member') AND d.publication_attempted
 AND d.state NOT IN ('verified','not_applicable') AND (d.signed_events IS NOT NULL OR d.publication_event_ids IS NOT NULL OR d.result_code = 'concord_recovery_requires_operator'))`;
export async function publicationBlockers(sql: postgres.Sql, communityId: string) {
  const rows = await sql`SELECT c.decision_id, c.org_id, d.signed_events IS NOT NULL AS has_bytes,
    d.publication_attempted, d.publication_event_ids, d.publication_metadata IS NOT NULL AS has_metadata, d.recovery_version,
    d.lease_until > clock_timestamp() AS leased
    FROM moderation.deliveries d JOIN moderation.decisions c USING (decision_id)
    WHERE c.community_id = ${communityId} AND (${sql.unsafe(uncertain)} OR (d.target = 'concord' AND c.action IN ('ban_member','unban_member') AND d.state IN ('pending','acknowledged') AND d.lease_until > clock_timestamp())) ORDER BY c.created_at, c.decision_id`;
  return rows.map(row => ({ decisionId: row.decision_id as string, orgId: row.org_id as string,
    publicationAttempted: Boolean(row.publication_attempted), eventId: row.publication_event_ids?.[0] as string | undefined, recoveryVersion: row.recovery_version as number,
    recovery: !row.publication_attempted ? "wait_for_current_lease" : !row.publication_event_ids?.length ? "authentic_provenance_or_separate_community" : row.has_bytes ? row.has_metadata ? "exact_replay_or_owner_supersession" : "replay_before_expiry_or_recover_original_event" : row.has_metadata ? "canonical_receipt_or_owner_supersession" : "recover_original_event",
    leased: Boolean(row.leased) }));
}
/** First public pilots cannot adopt unknown pre-upgrade publication history. */
export async function assertPilotPublicationProvenance(sql: postgres.Sql, communityId: string): Promise<void> {
  if ((await publicationBlockers(sql, communityId)).some(row => row.publicationAttempted && (!row.eventId || row.recovery === "recover_original_event"))) throw new Error("pilot_publication_provenance_required: recover authentic original provenance or provision a separate public pilot community");
}
export interface RecoveryRequest { decisionId: string; expectedVersion: number; eventId: string; operation: "replay" | "prove"; reason: string; originalEvent?: NostrEvent }
/** Run only in maintenance with the worker stopped. Both controller ownership
 * and execution ownership are checked, rather than trusting an operator flag. */
export async function recoverPublication(options: { sql: postgres.Sql; decisions: Decisions; cipher: EvidenceCipher; actions: ConcordActions; relay: Pick<RelayPool, "publish" | "queryStrict">; actor: VerifiedCoopActor; request: RecoveryRequest }) {
  const { sql, decisions, cipher, actions, relay, actor, request } = options;
  if (!actor.permissions.includes("recover_publication") || !Number.isSafeInteger(request.expectedVersion) || request.expectedVersion < 0 || !/^[0-9a-f]{64}$/.test(request.eventId) || !["replay", "prove"].includes(request.operation) || typeof request.reason !== "string" || !request.reason.trim() || request.reason.length > 2048) throw new Error("Recovery authorization or request invalid");
  const status = await decisions.get(request.decisionId, actor);
  if (status.action === "remove_message" || !actor.permissions.includes(status.action)) throw new Error("Recovery scope unavailable");
  return sql.begin(async leader => {
    for (const namespace of [483218, 483215]) {
      const [lock] = await leader`SELECT pg_try_advisory_xact_lock(hashtextextended(${status.target.communityId}, ${namespace})) AS owned`;
      if (!lock.owned) throw new Error("Stop community worker before recovery");
    }
    const [row] = await sql`SELECT c.*, d.signed_events, d.publication_event_ids, d.publication_metadata, d.attempts, d.recovery_version, d.state, d.lease_until
      FROM moderation.decisions c JOIN moderation.deliveries d USING (decision_id) WHERE c.decision_id = ${request.decisionId} AND c.org_id = ${actor.orgId} AND d.target = 'concord'`;
    if (!row || ["verified", "not_applicable"].includes(row.state) || row.recovery_version !== request.expectedVersion || row.lease_until > new Date() || row.publication_event_ids?.length !== 1 || row.publication_event_ids[0] !== request.eventId) throw new Error("Stale recovery or original publication identity unavailable");
    const decision: StoredDecision = { decisionId: row.decision_id, orgId: row.org_id, caseId: row.case_id, target: status.target, action: row.action, author: row.author, discordGuildConfirmed: row.discord_guild_confirmed, expiresAt: row.expires_at };
    // Proof operations still require current room authority, without granting
    // permission to execute an expired decision.
    await actions.authorize({ ...decision, expiresAt: new Date(Date.now() + 60_000) });
    let events: NostrEvent[] | undefined = row.signed_events ?? (request.originalEvent ? [request.originalEvent] : undefined);
    if (events) {
      if (events.length !== 1 || verifiedEvent(events[0]).id !== request.eventId) throw new Error("Original publication identity mismatch");
    }
    let outcome: { state: "verified" | "not_applicable" | "failed"; code: string } | undefined;
    if (request.operation === "prove") {
      if (!events) {
        const found = await relay.queryStrict([{ ids: [request.eventId] }]);
        events = found.filter(event => verifiedEvent(event).id === request.eventId);
        if (!events.length) events = undefined;
      }
      if (events && await actions.publicationInCurrentHistory(decision, events)) outcome = { state: "not_applicable", code: "concord_publication_settled" };
      else {
        const metadata: PublicationMetadata | undefined = row.publication_metadata ?? (events ? actions.publicationMetadata(events) : undefined);
        if (!metadata || !await actions.ownerSupersession(decision, metadata)) throw new Error("Canonical owner supersession proof required");
        outcome = { state: "not_applicable", code: "concord_operator_superseded" };
      }
    } else {
      if (!events || !row.signed_events || decision.expiresAt <= new Date()) throw new Error("Exact retained unexpired publication required");
      await actions.validatePrepared(decision, events);
    }
    const token = crypto.randomUUID(), recoveryId = crypto.randomUUID();
    // The durable audit commits before any network effect. The recovery count
    // is its own CAS; the ordinary eight-attempt budget is never reset.
    await sql.begin(async tx => {
      await lockLifecycleDecision(tx, actor.orgId, request.decisionId);
      const changed = await tx`UPDATE moderation.deliveries SET recovery_version = recovery_version + 1, state = 'pending', token = ${token}, lease_until = clock_timestamp() + interval '60 seconds'
        WHERE decision_id = ${request.decisionId} AND target = 'concord' AND recovery_version = ${request.expectedVersion}
          AND state NOT IN ('verified','not_applicable') AND publication_attempted AND publication_event_ids = ARRAY[${request.eventId}]
          AND (lease_until IS NULL OR lease_until <= clock_timestamp()) RETURNING target`;
      if (!changed.length) throw new Error("Stale recovery");
      const audit = cipher.seal(`${actor.orgId}:${recoveryId}`, { actorId: actor.actorId, reason: request.reason });
      await tx`INSERT INTO moderation.publication_recoveries (recovery_id, decision_id, org_id, recovery_version, event_id, operation)
        VALUES (${recoveryId}, ${request.decisionId}, ${actor.orgId}, ${request.expectedVersion + 1}, ${request.eventId}, ${request.operation})`;
      await tx`INSERT INTO moderation.lifecycle_events (event_id, org_id, case_id, decision_id, kind, encrypted_audit)
        VALUES (${recoveryId}, ${actor.orgId}, ${row.case_id}, ${request.decisionId}, 'publication_recovery', ${audit})`;
    });
    const claim: DeliveryClaim = { decision, target: "concord", token, attempts: row.attempts, signedEvents: row.signed_events, publicationEventIds: row.publication_event_ids, publicationAttempted: true };
    const current = async () => { await leader`SELECT 1`; await decisions.renew(claim); };
    if (!outcome) {
      try { const result = await deliverConcord(claim, actions, decisions, relay, current); outcome = { state: result.state === "verified" || result.state === "not_applicable" ? result.state : "failed", code: result.code }; }
      catch (error) { outcome = { state: "failed", code: error instanceof RetryableDeliveryError ? error.code : "concord_operator_recovery_failed" }; }
    }
    if (!outcome) throw new Error("Recovery outcome unavailable");
    await current();
    if (outcome.code === "concord_operator_superseded" && !await actions.ownerSupersession(decision, row.publication_metadata ?? actions.publicationMetadata(events!))) throw new Error("Supersession proof changed");
    await current();
    await sql.begin(async tx => {
      const locked = await lockLifecycleDecision(tx, actor.orgId, request.decisionId);
      const relayLeg = locked.deliveries.find(delivery => delivery.target === "divine_relay");
      if (outcome!.code === "concord_operator_superseded" && decision.action === "unban_member" && relayLeg && !["verified", "not_applicable"].includes(relayLeg.state) && relayLeg.lease_until > new Date()) throw new Error("Outstanding relay delivery lease");
      await decisions.complete(claim, outcome!.state, outcome!.code, 0, tx);
      // Supersession does not apply this unban at the relay. Retire its old
      // dependent work in the same fenced transaction instead of leaving it
      // waiting forever (or expiring into an uncloseable failed leg). Fresh
      // ordered intent still supplies any desired relay change.
      if (outcome!.code === "concord_operator_superseded" && decision.action === "unban_member") await tx`UPDATE moderation.deliveries SET state = 'not_applicable', result_code = 'concord_operator_superseded', token = NULL, lease_until = NULL, updated_at = clock_timestamp()
        WHERE decision_id = ${request.decisionId} AND target = 'divine_relay' AND state NOT IN ('verified','not_applicable') AND (lease_until IS NULL OR lease_until <= clock_timestamp())`;
    });
    return { recoveryId, ...outcome };
  });
}
