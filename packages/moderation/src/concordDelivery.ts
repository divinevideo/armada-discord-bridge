import type { NostrEvent } from "nostr-tools/pure";
import type { RelayPool } from "../../bridge/src/concord/pool";
import { StalePreparedBanlistError, type ConcordActions } from "./concordActions";
import type { Decisions, DeliveryClaim } from "./decisions";
import { RetryableDeliveryError, type DeliveryAttempt } from "./discordActions";
import { verifiedEvent } from "./relayPolicy";
export async function deliverConcord(claim: DeliveryClaim, actions: ConcordActions, decisions: Pick<Decisions, "saveEvents" | "replaceUnattemptedEvents" | "markPublicationAttempted">, relay: Pick<RelayPool, "publish" | "queryStrict">, assertCurrent: () => Promise<void>): Promise<DeliveryAttempt> {
  let events = (claim.signedEvents ?? await decisions.saveEvents(claim, await actions.prepare(claim.decision))) as NostrEvent[];
  try { await actions.validatePrepared(claim.decision, events); } catch (error) {
    if (!(error instanceof StalePreparedBanlistError)) throw error;
    // Relay absence is not proof of non-publication. Rebase only a generation
    // whose durable send marker is false; legacy/uncertain bytes need an
    // operator, not a new edition that could undo intervening moderation.
    if (claim.publicationAttempted !== false) return { state: "failed", code: "concord_recovery_requires_operator" };
    await assertCurrent();
    events = await decisions.replaceUnattemptedEvents(claim, events, await actions.prepare(claim.decision)) as NostrEvent[];
    await actions.validatePrepared(claim.decision, events);
  }
  for (const event of events) {
    await assertCurrent();
    await actions.authorize(claim.decision);
    await decisions.markPublicationAttempted(claim, events);
    try { await relay.publish(event); } catch { throw new RetryableDeliveryError("concord_transport_unavailable"); }
  }
  const fetched = await relay.queryStrict([{ ids: events.map((event) => event.id) }]).catch(() => { throw new RetryableDeliveryError("concord_readback_unavailable"); });
  const found = new Set(fetched.map((event) => verifiedEvent(event).id));
  if (events.some((event) => !found.has(event.id))) return { state: "acknowledged", code: "concord_awaiting_readback" };
  // Refresh authority after readback as well: a losing banlist edition can be
  // stored successfully while never becoming the canonical community state.
  try { await actions.validatePrepared(claim.decision, events); } catch (error) {
    if (error instanceof StalePreparedBanlistError) return { state: "failed", code: "concord_recovery_requires_operator" };
    throw error;
  }
  if (claim.decision.action !== "remove_message") {
    const { folded } = await actions.authorize(claim.decision);
    if (folded.banned.has(claim.decision.author) !== (claim.decision.action === "ban_member")) return { state: "acknowledged", code: "concord_awaiting_fold" };
  }
  return { state: "verified", code: "concord_enforcement_verified" };
}
