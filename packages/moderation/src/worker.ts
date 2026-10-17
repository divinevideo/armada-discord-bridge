import type postgres from "postgres";
import type { DeliveryTarget, RoomTarget } from "./contracts";
import type { Decisions, DeliveryClaim, StoredDecision } from "./decisions";
import { RetryableDeliveryError, type DiscordActions, type DeliveryAttempt } from "./discordActions";
export interface ExecutionContext {
  authorize(decision: StoredDecision): Promise<unknown>;
  assertCurrent(): Promise<void>;
  removeFromRelay(target: RoomTarget, decisionId: string): Promise<{ state: string }>;
  setRelayBan(decision: StoredDecision): Promise<boolean>;
  executeConcord(decision: StoredDecision): Promise<DeliveryAttempt>;
  discord: Pick<DiscordActions, "execute">;
}
export async function executeDelivery(decision: StoredDecision, target: DeliveryTarget, context: ExecutionContext): Promise<DeliveryAttempt> {
  try {
    await context.authorize(decision);
    await context.assertCurrent();
    if (target === "discord") return context.discord.execute(decision);
    if (target === "concord") return context.executeConcord(decision);
    if (decision.action === "remove_message") {
      const result = await context.removeFromRelay(decision.target, decision.decisionId);
      return { state: result.state === "verified" ? "verified" : "failed", code: result.state === "verified" ? "relay_removal_verified" : "relay_removal_unverified" };
    }
    return await context.setRelayBan(decision)
      ? { state: "verified", code: "relay_member_policy_verified" }
      : { state: "acknowledged", code: "relay_awaiting_concord_state" };
  } catch (error) { return error instanceof RetryableDeliveryError ? { state: "pending", code: error.code } : { state: "failed", code: "current_authority_or_delivery_unavailable" }; }
}
/** A session transaction serializes mutations for one community. Every side
 * effect checks both the live transaction and the renewable outbox token. */
export class ModerationWorker {
  constructor(private readonly sql: postgres.Sql, private readonly decisions: Decisions, private readonly context: (claim: DeliveryClaim, assertCurrent: () => Promise<void>) => Promise<ExecutionContext>) {}
  async tick(): Promise<boolean> {
    const claim = await this.decisions.claim();
    if (!claim) return false;
    let renewalFailed = false;
    const timer = setInterval(() => { void this.decisions.renew(claim).catch(() => { renewalFailed = true; }); }, 15_000);
    timer.unref();
    try {
      await this.sql.begin(async (tx) => {
        const [lock] = await tx`SELECT pg_try_advisory_xact_lock(hashtextextended(${claim.decision.target.communityId}, 483215)) AS owned`;
        if (!lock.owned) { await this.decisions.defer(claim); return; }
        const assertCurrent = async () => {
          if (renewalFailed) throw new Error("Delivery ownership lost");
          await tx`SELECT 1`;
          await this.decisions.renew(claim);
          if (renewalFailed || claim.decision.expiresAt.getTime() <= Date.now()) throw new Error("Delivery ownership or evidence expired");
        };
        const context = await this.context(claim, assertCurrent);
        const result = await executeDelivery(claim.decision, claim.target, context);
        await assertCurrent();
        await this.decisions.complete(claim, result.state, result.code, result.retryAfterSeconds);
      });
    } catch {
      await this.decisions.complete(claim, "failed", "worker_ownership_or_delivery_failed").catch(() => {});
    } finally { clearInterval(timer); }
    return true;
  }
}
