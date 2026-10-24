import { readFile } from "node:fs/promises";
import type postgres from "postgres";
import { CAPACITY_REFUSAL, CapacityRefusal, PublicCapacityStore } from "./publicCapacity";
import type { PublicCapacityContract } from "./capacityContract";
import { openWrap, parseEdition, banlistLocator, hex32, isAuthorized, Permissions, citationFromTags, citationSatisfied } from "@armada-bridge/concord-core";
import type { NostrEvent } from "nostr-tools/pure";
import { bytesToHex } from "@armada-bridge/concord-core";
import type { AdmissionResult, CommunityPolicy, RoomTarget, StreamDescriptor } from "./contracts";
import { controlState, HEX_ID, inspectRelayEvent, MAX_EVENT_BYTES, verifiedEvent } from "./relayPolicy";

type Sql = postgres.Sql | postgres.TransactionSql;
const LOCK_NAMESPACE = 483210;
export async function migrateModeration(sql: postgres.Sql): Promise<void> {
  const bodies = await Promise.all(["001_moderation.sql", "002_reports.sql", "003_stream_retirement.sql", "004_pending_rekeys.sql", "005_observed_members.sql", "006_incoming_moderation.sql", "007_coop_handoff.sql", "008_api_role.sql", "009_api_case_lock.sql", "010_concord_publication_attempt.sql", "011_api_delivery_retry.sql", "012_member_decision_supersession.sql", "013_member_source_order.sql", "014_carrier_references.sql", "015_publication_receipt_ids.sql", "016_guild_scope_order.sql", "017_moderation_lifecycle.sql", "018_public_capacity.sql", "019_audit_restriction_refresh.sql", "020_audit_closure_guard.sql", "021_hold_extension.sql", "022_settled_publication_audit.sql", "023_publication_recovery.sql", "024_removal_progress.sql"].map((name) => readFile(new URL(`../db/migrations/${name}`, import.meta.url), "utf8")));
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE}, 1)`;
    for (const body of bodies) await tx.unsafe(body);
  });
}
export function policyLock(sql: Sql, communityId: string, shared = false) {
  return shared
    ? sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${communityId}, ${LOCK_NAMESPACE}))`
    : sql`SELECT pg_advisory_xact_lock(hashtextextended(${communityId}, ${LOCK_NAMESPACE}))`;
}
function requireId(value: string): void { if (!HEX_ID.test(value)) throw new Error("Invalid target"); }
function streamOf(row: Record<string, any>): StreamDescriptor {
  return { communityId: row.community_id, channelId: row.channel_id ?? undefined, plane: row.plane, epoch: String(row.epoch), retiredAt: row.retired_at == null ? undefined : Number(row.retired_at), previousEpoch: row.previous_epoch == null ? undefined : String(row.previous_epoch), previousCommit: row.previous_commit ?? undefined, key: { pk: row.pubkey, convKey: new Uint8Array(row.read_key), restricted: row.restricted } };
}

export interface PolicyStoreOptions { capacity?: { communities: ReadonlyMap<string, string>; contract: PublicCapacityContract | undefined }; onAdmissionTiming?: (sample: { innerAdmissionMs: number; action: "accept" | "reject" }) => void }
export class PolicyStore {
  private readonly capacity: PublicCapacityStore | undefined;
  constructor(private readonly sql: postgres.Sql, private readonly options: PolicyStoreOptions = {}) { if (options.capacity) this.capacity = new PublicCapacityStore(sql, options.capacity.contract); }

  async install(policy: CommunityPolicy, streams: StreamDescriptor[], expectedRevision: number): Promise<void> {
    if (policy.revision !== expectedRevision + 1 || !Number.isSafeInteger(policy.revision)) throw new Error("Policy revision conflict");
    if (streams.length === 0 || streams.length > 1024 || streams.some((s) => s.communityId !== policy.communityId || "sk" in s.key || s.key.convKey.length !== 32)) throw new Error("Invalid read-only stream descriptors");
    if (policy.validUntil > Date.now() + 120_000 || policy.validUntil <= Date.now()) throw new Error("Policy freshness deadline invalid");
    const { folded } = controlState(policy);
    if (!policy.complete || folded.incomplete.length || policy.banned.includes(policy.owner)) throw new Error("Incomplete policy or invalid owner target");
    for (const pk of [...policy.banned, ...policy.publicAuthors, ...policy.snapshotAuthorities]) requireId(pk);
    if (new Set(streams.map((s) => s.key.pk)).size !== streams.length) throw new Error("Duplicate stream descriptor");
    const controlStreams = streams.filter((s) => s.plane === "control");
    if (controlStreams.length !== policy.controlStreams.length || policy.controlStreams.some((s) => !controlStreams.some((c) => c.key.pk === s.key.pk && Buffer.from(c.key.convKey).equals(Buffer.from(s.key.convKey))))) throw new Error("Control stream descriptors differ");
    for (const s of streams.filter((s) => s.plane === "chat")) {
      const channel = s.channelId && folded.channels.get(s.channelId);
      if (!channel || channel.deleted || channel.metadata.private) throw new Error("Only public managed channels are accepted");
    }
    await this.sql.begin(async (tx) => {
      await policyLock(tx, policy.communityId);
      const [old] = await tx`SELECT revision, payload FROM moderation.community_policy WHERE community_id = ${policy.communityId}`;
      if (Number(old?.revision ?? 0) !== expectedRevision) throw new Error("Policy revision conflict");
      if (old) {
        const oldPolicy = await this.load(tx, policy.communityId);
        if (BigInt(policy.rootEpoch ?? "0") < BigInt(oldPolicy!.rootEpoch ?? "0")) throw new Error("Root epoch would roll back");
        const previous = controlState(oldPolicy!).folded;
        for (const [entity, head] of previous.heads) {
          const next = folded.heads.get(entity);
          if (!next || next.version < head.version || (next.version === head.version && bytesToHex(next.hash) !== bytesToHex(head.hash))) throw new Error("Control state would roll back");
        }
      }
      const { controlStreams: _readMaterial, ...payload } = policy;
      await tx`INSERT INTO moderation.community_policy (community_id, revision, payload)
        VALUES (${policy.communityId}, ${policy.revision}, ${tx.json(payload as never)})
        ON CONFLICT (community_id) DO UPDATE SET revision = EXCLUDED.revision, payload = EXCLUDED.payload, updated_at = clock_timestamp()`;
      await tx`DELETE FROM moderation.streams WHERE community_id = ${policy.communityId}`;
      for (const s of streams) {
        await tx`INSERT INTO moderation.streams (pubkey, community_id, channel_id, plane, epoch, read_key, restricted, retired_at, previous_epoch, previous_commit)
          VALUES (${s.key.pk}, ${s.communityId}, ${s.channelId ?? null}, ${s.plane}, ${s.epoch}, ${Buffer.from(s.key.convKey)}, ${s.key.restricted ?? false}, ${s.retiredAt ?? null}, ${s.previousEpoch ?? null}, ${s.previousCommit ?? null})`;
      }
    });
  }

  private async load(sql: Sql, communityId: string): Promise<CommunityPolicy | undefined> {
    const [row] = await sql`SELECT revision, payload FROM moderation.community_policy WHERE community_id = ${communityId}`;
    if (!row) return undefined;
    const streams = await sql`SELECT * FROM moderation.streams WHERE community_id = ${communityId} AND plane = 'control'`;
    return { ...row.payload, ...await this.overlay(sql, communityId, row.payload), revision: Number(row.revision), controlStreams: streams.map(streamOf) };
  }

  /** Installed and maintenance authority must see the same durable additions.
   * Omitting a pending rekey or relay ban would make proof authorize a member
   * the normal installed-policy path refuses. This helper only reads. */
  private async overlay(sql: Sql, communityId: string, payload: Pick<CommunityPolicy, "controlEvents" | "banned" | "rootEpoch">) {
    const accepted = await sql`SELECT event FROM moderation.accepted_control WHERE community_id = ${communityId} LIMIT 4097`;
    const controlEvents = [...new Map([...payload.controlEvents, ...accepted.map((entry) => entry.event)].map((event) => [event.id, event])).values()];
    if (controlEvents.length > 4096) throw new Error("Control history exceeds bound");
    const overrides = await sql`SELECT author, blocked FROM moderation.member_bans WHERE community_id = ${communityId}`;
    const banned = new Set<string>(payload.banned);
    for (const override of overrides) {
      if (override.blocked) banned.add(override.author); else banned.delete(override.author);
    }
    const pending = await sql`SELECT 1 FROM moderation.rekey_events WHERE community_id = ${communityId} AND epoch > ${payload.rootEpoch ?? "0"} LIMIT 1`;
    return { controlEvents, rekeyPending: pending.length > 0, banned: [...banned] };
  }

  /** Apply installed-policy overlays without persisting an admission grant. */
  async snapshot(policy: CommunityPolicy): Promise<CommunityPolicy> {
    requireId(policy.communityId);
    return { ...policy, ...await this.overlay(this.sql, policy.communityId, policy) };
  }

  async rekeyEvents(communityId: string): Promise<NostrEvent[]> {
    requireId(communityId);
    const rows = await this.sql`SELECT event FROM moderation.rekey_events WHERE community_id = ${communityId} LIMIT 4097`;
    if (rows.length > 4096) throw new Error("Rekey reconciliation exceeds bound");
    return rows.map((row) => row.event as NostrEvent);
  }

  async getPolicy(communityId: string) { requireId(communityId); return this.load(this.sql, communityId); }

  async admit(event: NostrEvent, signal?: AbortSignal): Promise<AdmissionResult> {
    const start = performance.now();
    const result = await this.admitEvent(event, false, signal);
    try { this.options.onAdmissionTiming?.({ innerAdmissionMs: performance.now() - start, action: result.action }); } catch { /* Telemetry cannot reverse a settled database result. */ }
    return result;
  }

  private async admitEvent(event: NostrEvent, restoring: boolean, signal?: AbortSignal): Promise<AdmissionResult> {
    const admissionStart = performance.now();
    const id = typeof event?.id === "string" && HEX_ID.test(event.id) ? event.id : "0".repeat(64);
    const rejected: AdmissionResult = { id, action: "reject", msg: "blocked: room policy unavailable or event not permitted" };
    try {
      signal?.throwIfAborted();
      if (Buffer.byteLength(JSON.stringify(event)) > MAX_EVENT_BYTES || !HEX_ID.test(event.pubkey)) return rejected;
      return await this.sql.begin(async (tx) => {
        signal?.throwIfAborted();
        await tx.unsafe("SET LOCAL statement_timeout = '1500ms'");
        if (restoring) {
          // A removed public stream has no current scope. Rejecting it is safe
          // only while the whole recovery policy is available, not merely when
          // a key lookup returns no rows. Lock before lookup so a refresh cannot
          // turn that absence into permission while we decide to delete bytes.
          const communities = await tx`SELECT community_id FROM moderation.community_policy ORDER BY community_id`;
          if (!communities.length) throw new Error("Recovery policy unavailable");
          for (const row of communities) {
            await policyLock(tx, row.community_id);
            this.assertRecoveryPolicy(await this.load(tx, row.community_id));
          }
        }
        const candidates = await tx`SELECT community_id FROM moderation.streams WHERE pubkey = ${event.pubkey}
          UNION SELECT community_id FROM moderation.community_policy WHERE payload->'publicAuthors' ? ${event.pubkey}
          UNION SELECT community_id FROM moderation.observed_members WHERE author = ${event.pubkey} LIMIT 2`;
        if (candidates.length !== 1) {
          if (restoring && candidates.length > 1) throw new Error("Recovery policy scope unavailable");
          return rejected;
        }
        const communityId = candidates[0].community_id as string;
        await policyLock(tx, communityId);
        const policy = await this.load(tx, communityId);
        signal?.throwIfAborted();
        if (restoring) this.assertRecoveryPolicy(policy);
        const [row] = await tx`SELECT * FROM moderation.streams WHERE pubkey = ${event.pubkey} AND community_id = ${communityId}`;
        const known = await tx`SELECT 1 FROM moderation.observed_members WHERE community_id = ${communityId} AND author = ${event.pubkey}`;
        // The inspector maps callback errors to rejection for live admission.
        // Restore must retain the distinction before deciding to remove bytes.
        const lookupFailures: unknown[] = [];
        const lookup = async <T>(read: () => Promise<T>): Promise<T> => {
          try { return await read(); }
          catch (error) { lookupFailures.push(error); throw error; }
        };
        const { result, carrier, references, rekey, observedAuthor, control, removals, retraction } = await inspectRelayEvent(event, {
          policy, stream: row && streamOf(row), now: Date.now, publicAuthorKnown: known.length > 0,
          isRemoved: (target) => lookup(async () => (await tx`SELECT 1 FROM moderation.tombstones WHERE community_id = ${target.communityId} AND channel_id = ${target.channelId} AND rumor_id = ${target.rumorId}`).length > 0),
          authorOf: (target) => lookup(async () => (await tx`SELECT author FROM moderation.carriers WHERE community_id = ${target.communityId} AND channel_id = ${target.channelId} AND rumor_id = ${target.rumorId} LIMIT 1`)[0]?.author as string | undefined),
        });
        if (restoring) {
          if (lookupFailures.length) throw lookupFailures[0];
          this.assertRecoveryPolicy(policy);
          if (references) await tx`UPDATE moderation.carriers SET target_rumor_ids = ${references.ids}, targets_indexed = true
            WHERE event_id = ${references.eventId} AND community_id = ${references.target.communityId} AND channel_id = ${references.target.channelId} AND rumor_id = ${references.target.rumorId}`;
        }
        signal?.throwIfAborted();
        if (!restoring && result.action === "accept" && this.capacity) {
          const org = this.options.capacity!.communities.get(communityId); if (!org) return rejected;
          let urgent = Boolean(rekey);
          if (row) {
            const opened = openWrap(event, streamOf(row).key), state = controlState(policy!);
            if (control) urgent = bytesToHex(parseEdition(opened).entityId) === bytesToHex(banlistLocator(hex32(communityId)));
            else if (opened.kind === 5 || opened.kind === 3309) urgent = isAuthorized(state.folded.roster, opened.author, policy!.owner, opened.kind === 5 ? Permissions.MANAGE_MESSAGES : Permissions.KICK) && citationSatisfied(state.folded, hex32(communityId), opened.author, citationFromTags(opened.tags));
          }
          // Verified self-deletions and guestbook leaves use the same measured
          // gate as staff actions. They add no control or rekey history, so
          // they preserve the finite reserve for actions that grow history.
          if (retraction && !control && !rekey) urgent = true;
          await this.capacity.assertAdmission(tx, policy!, org, urgent, { control: control?.id, rekey: rekey?.event.id, bytes: Buffer.byteLength(JSON.stringify(event)) }, performance.now() - admissionStart);
        }
        if (result.action === "accept" && control) await tx`INSERT INTO moderation.accepted_control (community_id, event_id, event) VALUES (${communityId}, ${control.id}, ${tx.json(control as never)}) ON CONFLICT DO NOTHING`;
        if (result.action === "accept") for (const target of removals ?? []) {
          await tx`INSERT INTO moderation.tombstones (community_id, channel_id, rumor_id) VALUES (${communityId}, ${target.channelId}, ${target.rumorId}) ON CONFLICT DO NOTHING`;
          await tx`INSERT INTO moderation.incoming_removals (community_id, channel_id, rumor_id) VALUES (${communityId}, ${target.channelId}, ${target.rumorId}) ON CONFLICT DO NOTHING`;
        }
        if (result.action === "accept" && observedAuthor) await tx`INSERT INTO moderation.observed_members (community_id, author) VALUES (${communityId}, ${observedAuthor}) ON CONFLICT DO NOTHING`;
        if (result.action === "accept" && carrier) {
          await tx`INSERT INTO moderation.carriers (community_id, channel_id, rumor_id, event_id, author, kind, policy_revision, expires_at, target_rumor_ids, targets_indexed)
            VALUES (${carrier.communityId}, ${carrier.channelId}, ${carrier.rumorId}, ${carrier.eventId}, ${carrier.author}, ${carrier.kind}, ${carrier.policyRevision}, ${carrier.expiresAt ? new Date(carrier.expiresAt) : null}, ${carrier.targetRumorIds ?? []}, true)
            ON CONFLICT (event_id) DO UPDATE SET target_rumor_ids = EXCLUDED.target_rumor_ids, targets_indexed = true`;
        }
        if (result.action === "accept" && rekey) await tx`INSERT INTO moderation.rekey_events (event_id, community_id, epoch, event)
          VALUES (${rekey.event.id}, ${rekey.communityId}, ${rekey.epoch}, ${tx.json(rekey.event as never)}) ON CONFLICT DO NOTHING`;
        // Throwing here rolls all policy/index writes back before admission can
        // settle. The plugin waits for that settlement before emitting bytes.
        signal?.throwIfAborted();
        return result;
      });
    } catch (error) {
      if (restoring) throw error;
      // Only the capacity gate's own refusal is named. It runs after policy
      // accepted the event, so it says nothing about why anything else fails.
      return error instanceof CapacityRefusal ? { id, action: "reject", msg: CAPACITY_REFUSAL } : rejected;
    }
  }

  private assertRecoveryPolicy(policy: CommunityPolicy | undefined): asserts policy is CommunityPolicy {
    if (!policy || !Number.isSafeInteger(policy.revision) || policy.revision < 1 || !policy.complete || policy.validUntil <= Date.now() || controlState(policy).folded.incomplete.length) throw new Error("Recovery policy unavailable");
  }

  async assertRestoreReady(floors: Record<string, number>): Promise<void> {
    const rows = await this.sql`SELECT community_id FROM moderation.community_policy`;
    if (rows.length !== Object.keys(floors).length) throw new Error("Recovery policy scope mismatch");
    for (const row of rows) {
      const policy = await this.load(this.sql, row.community_id);
      const floor = floors[row.community_id];
      if (!policy || !floor || policy.revision < floor || !policy.complete || policy.validUntil <= Date.now() || controlState(policy).folded.incomplete.length) throw new Error("Recovery policy unavailable or behind floor");
    }
  }

  async admitRestored(input: NostrEvent): Promise<boolean> {
    // Historical control editions are needed to reconstruct authority. They are
    // retained only if their exact verified bytes are in the installed fold.
    const event = verifiedEvent(input);
    const [stream] = await this.sql`SELECT community_id FROM moderation.streams WHERE pubkey = ${event.pubkey} AND plane = 'control'`;
    if (stream) {
      const policy = await this.load(this.sql, stream.community_id);
      this.assertRecoveryPolicy(policy);
      return policy.controlEvents.some((candidate) => candidate.id === event.id);
    }
    return (await this.admitEvent(event, true)).action === "accept";
  }

  /** Disconnects revoke admission immediately; a new complete snapshot must win CAS. */
  async invalidate(communityId: string): Promise<number> {
    requireId(communityId);
    return this.sql.begin(async (tx) => {
      await policyLock(tx, communityId);
      const [row] = await tx`UPDATE moderation.community_policy
        SET revision = revision + 1,
            payload = payload || '{"complete":false,"validUntil":0}'::jsonb,
            updated_at = clock_timestamp()
        WHERE community_id = ${communityId} RETURNING revision`;
      if (!row) throw new Error("Policy unavailable");
      return Number(row.revision);
    });
  }

  async setBan(communityId: string, author: string, banned: boolean): Promise<number> {
    requireId(communityId); requireId(author);
    return this.sql.begin(async (tx) => {
      await policyLock(tx, communityId);
      const policy = await this.load(tx, communityId);
      if (!policy) throw new Error("Policy unavailable");
      if (author === policy.owner) throw new Error("The owner cannot be banned");
      await tx`INSERT INTO moderation.member_bans (community_id, author, blocked)
        VALUES (${communityId}, ${author}, ${banned}) ON CONFLICT (community_id, author) DO UPDATE SET blocked = EXCLUDED.blocked`;
      const [row] = await tx`UPDATE moderation.community_policy SET revision = revision + 1, updated_at = clock_timestamp()
        WHERE community_id = ${communityId} RETURNING revision`;
      return Number(row.revision);
    });
  }

  async remove(target: RoomTarget): Promise<number> {
    requireId(target.communityId); requireId(target.channelId); requireId(target.rumorId);
    return this.sql.begin(async (tx) => {
      await policyLock(tx, target.communityId);
      await tx`INSERT INTO moderation.tombstones (community_id, channel_id, rumor_id)
        VALUES (${target.communityId}, ${target.channelId}, ${target.rumorId}) ON CONFLICT DO NOTHING`;
      const [row] = await tx`UPDATE moderation.community_policy SET revision = revision + 1, updated_at = clock_timestamp()
        WHERE community_id = ${target.communityId} RETURNING revision`;
      return Number(row.revision);
    });
  }
}
