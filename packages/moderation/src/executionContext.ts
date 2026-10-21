import type postgres from "postgres";
import type { RelayPool } from "../../bridge/src/concord/pool";
import type { ConcordActions } from "./concordActions";
import type { Decisions, DeliveryClaim } from "./decisions";
import type { DiscordActions } from "./discordActions";
import type { PolicyStore } from "./policyStore";
import type { PurgeDriver, RelayPurger } from "./relayPurge";
import type { ExecutionContext } from "./worker";
import { deliverConcord, settledConcordReceipt } from "./concordDelivery";
export function createExecutionContext(options: { sql: postgres.Sql; store: PolicyStore; actions: ConcordActions; claim: DeliveryClaim; assertCurrent(): Promise<void>; decisions: Decisions; relay: Pick<RelayPool, "publish" | "queryStrict">; discord: Pick<DiscordActions, "execute">; purger: RelayPurger; driver: Pick<PurgeDriver, "barrier"> }): ExecutionContext {
  return {
    reconcileOnly: options.claim.reconcileOnly,
    authorize: (decision) => options.actions.authorize(decision),
    assertCurrent: options.assertCurrent,
    discord: options.discord,
    executeConcord: () => deliverConcord(options.claim, options.actions, options.decisions, options.relay, options.assertCurrent),
    removeFromRelay: (target, id) => options.purger.removeFromRelay(target, id),
    async setRelayBan(decision) {
      if (decision.action === "unban_member") {
        // Canonical readback settles a publication without calling it a new
        // verified send. Accept only those exact receipts, never an arbitrary
        // not_applicable result, and still require the current fold to unban.
        const [delivery] = await options.sql`SELECT state, result_code FROM moderation.deliveries WHERE decision_id = ${decision.decisionId} AND target = 'concord'`;
        const settled = delivery && settledConcordReceipt(delivery.state, delivery.result_code);
        if (!(delivery?.state === "verified" || settled) || (await options.actions.authorize(decision)).folded.banned.has(decision.author)) return false;
      }
      await options.assertCurrent();
      await options.actions.authorize(decision);
      await options.store.setBan(decision.target.communityId, decision.author, decision.action === "ban_member");
      return options.driver.barrier(async () => {
        await options.assertCurrent();
        const { policy, folded } = await options.actions.authorize(decision);
        const blocked = policy.banned.includes(decision.author) || folded.banned.has(decision.author);
        return blocked === (decision.action === "ban_member");
      });
    },
  };
}
