import type { NostrEvent } from "nostr-tools/pure";
import type { RelayPool } from "../../bridge/src/concord/pool";
import type { ConcordActions } from "./concordActions";
import type { Decisions, DeliveryClaim } from "./decisions";
import type { DeliveryAttempt } from "./discordActions";
import { verifiedEvent } from "./relayPolicy";
export async function deliverConcord(claim: DeliveryClaim, actions: ConcordActions, decisions: Pick<Decisions, "saveEvents">, relay: Pick<RelayPool, "publish" | "queryStrict">, assertCurrent: () => Promise<void>): Promise<DeliveryAttempt> {
  const events = (claim.signedEvents ?? await decisions.saveEvents(claim, await actions.prepare(claim.decision))) as NostrEvent[];
  await actions.validatePrepared(claim.decision, events);
  for (const event of events) {
    await assertCurrent();
    await actions.authorize(claim.decision);
    await relay.publish(event);
  }
  const fetched = await relay.queryStrict([{ ids: events.map((event) => event.id) }]);
  const found = new Set(fetched.map((event) => verifiedEvent(event).id));
  if (events.some((event) => !found.has(event.id))) return { state: "acknowledged", code: "concord_awaiting_readback" };
  // Refresh authority after readback as well: a losing banlist edition can be
  // stored successfully while never becoming the canonical community state.
  await actions.validatePrepared(claim.decision, events);
  if (claim.decision.action !== "remove_message") {
    const { folded } = await actions.authorize(claim.decision);
    if (folded.banned.has(claim.decision.author) !== (claim.decision.action === "ban_member")) return { state: "acknowledged", code: "concord_awaiting_fold" };
  }
  return { state: "verified", code: "concord_enforcement_verified" };
}
