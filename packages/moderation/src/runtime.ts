import { setTimeout as delay } from "node:timers/promises";
import type postgres from "postgres";
import { baseRekeyGroupKey, channelsView, controlGroups, guestbookGroups, registerStreamKeys } from "@armada-bridge/concord-core";
import type { CommunityV2 } from "@armada-bridge/concord-core";
import type { LocalIdentity } from "../../bridge/src/concord/signer";
import { RelayPool } from "../../bridge/src/concord/pool";
import { discordPublicChannelPolicy, type PublicChannelRules } from "../../bridge/src/discord/publicChannelPolicy";
import { CarrierIndex } from "./carrierIndex";
import { ConcordActions } from "./concordActions";
import type { Decisions } from "./decisions";
import type { Lifecycle } from "./lifecycle";
import { BridgeMappingResolver, DiscordActions, discordRequest } from "./discordActions";
import { createExecutionContext } from "./executionContext";
import { LocalRelayDriver } from "./localRelayDriver";
import { PolicyStore } from "./policyStore";
import { PolicyWatcher } from "./policyWatcher";
import { RelayPurger } from "./relayPurge";
import { controlState } from "./relayPolicy";
import { ModerationWorker } from "./worker";
export function validateWorkerCommunity(community: CommunityV2, moderatorPk: string, communities: ReadonlyMap<string, string>): void {
  if (!communities.has(community.idHex) || communities.size !== 1 || community.owner === moderatorPk || community.privateChannels.length) throw new Error("Worker requires one approved public community and a non-owner member identity");
}
/** Audit cleanup uses the worker's operator connection; the API only sweeps evidence. */
export async function expireModerationRecords(decisions: Pick<Decisions, "expire">, lifecycle: Pick<Lifecycle, "expireEvidence" | "expireAudit">): Promise<void> {
  await decisions.expire();
  await lifecycle.expireEvidence();
  await lifecycle.expireAudit();
}
export interface WorkerHealth { ready: boolean; code: "starting" | "ready" | "policy_unavailable" | "rekey_recovery_required" | "delivery_unavailable" | "stopped"; checkedAt: number }
export async function runModerationWorker(options: { sql: postgres.Sql; decisions: Decisions; lifecycle: Pick<Lifecycle, "expireEvidence" | "expireAudit">; community: CommunityV2; identity: LocalIdentity; communities: ReadonlyMap<string, string>; relayUrl: string; bridgeTenantId: string; puppetMaster: string; discordToken: string; publicChannels: PublicChannelRules; publicAuthors: string[]; signal: AbortSignal; health: WorkerHealth }): Promise<void> {
  validateWorkerCommunity(options.community, options.identity.pk, options.communities);
  const { sql, community, identity, health } = options;
  const store = new PolicyStore(sql), driver = new LocalRelayDriver(options.relayUrl);
  const purger = new RelayPurger(new CarrierIndex(sql), driver);
  let watcher: PolicyWatcher | undefined;
  const pool = new RelayPool([options.relayUrl], { onDisconnect: () => { health.ready = false; health.code = "policy_unavailable"; void watcher?.disconnected(); } });
  watcher = new PolicyWatcher(community, store, pool, [...options.publicAuthors, identity.pk], identity);
  const refresh = async () => {
    const policy = await watcher!.refresh();
    registerStreamKeys(channelsView(community, controlState(policy).folded).flatMap((channel) => channel.streams.map((stream) => stream.group)), pool.urls);
    health.checkedAt = Date.now();
    health.ready = !policy.rekeyPending;
    health.code = policy.rekeyPending ? "rekey_recovery_required" : "ready";
    return policy;
  };
  registerStreamKeys([...controlGroups(community), ...guestbookGroups(community), ...community.heldRoots.map((root) => baseRekeyGroupKey(root.key, community.id, root.epoch + 1n))], pool.urls);
  const actions = new ConcordActions(community, identity, refresh);
  const mappings = new BridgeMappingResolver(sql, options.bridgeTenantId, options.publicChannels.guildId, options.puppetMaster);
  const publicPolicy = discordPublicChannelPolicy(options.publicChannels, options.discordToken);
  let unsubscribe = () => {};
  try {
    // The transaction owns the controller for its full lifetime. A failed DB
    // connection aborts it; it cannot silently reconnect holding a lost lock.
    await sql.begin(async (leader) => {
      const [lock] = await leader`SELECT pg_try_advisory_xact_lock(hashtextextended(${community.idHex}, 483218)) AS owned`;
      if (!lock.owned) throw new Error("Community controller already owned");
      const assertLeadership = async () => { if (options.signal.aborted) throw new Error("Worker stopping"); await leader`SELECT 1`; };
      const worker = new ModerationWorker(sql, options.decisions, async (claim, assertCurrent) => {
        if (claim.decision.target.communityId !== community.idHex) throw new Error("Wrong worker scope");
        const owned = async () => { await assertLeadership(); await assertCurrent(); };
        return createExecutionContext({ sql, store, actions, claim, assertCurrent: owned, decisions: options.decisions, relay: pool, purger, driver, discord: new DiscordActions(mappings, publicPolicy, discordRequest(options.discordToken), async () => { await owned(); await actions.authorize(claim.decision); }) });
      });
      let controlChanged = true, nextRefresh = 0;
      unsubscribe = pool.subscribe([{ kinds: [1059], authors: controlGroups(community).map((group) => group.pk) }], {
        onEvent: () => { controlChanged = true; },
        onError: () => { health.ready = false; health.code = "policy_unavailable"; void watcher!.disconnected(); },
      });
      while (!options.signal.aborted) {
        await assertLeadership();
        try {
          if (controlChanged || Date.now() >= nextRefresh) { controlChanged = false; await refresh(); nextRefresh = Date.now() + 5000; }
          const incoming = await sql`SELECT community_id, channel_id, rumor_id, decision_id FROM moderation.incoming_removals
            WHERE community_id = ${community.idHex} AND NOT verified AND available_at <= clock_timestamp() LIMIT 20`;
          for (const row of incoming) {
            await assertLeadership();
            const result = await purger.removeFromRelay({ communityId: row.community_id, channelId: row.channel_id, rumorId: row.rumor_id }, row.decision_id);
            await sql`UPDATE moderation.incoming_removals SET verified = ${result.state === "verified"}, available_at = clock_timestamp() + interval '30 seconds' WHERE decision_id = ${row.decision_id}`;
            if (result.state !== "verified") { health.ready = false; health.code = "delivery_unavailable"; }
          }
          await worker.tick();
          await expireModerationRecords(options.decisions, options.lifecycle);
        } catch { health.ready = false; health.code = "policy_unavailable"; await watcher!.disconnected(); }
        await delay(1000, undefined, { signal: options.signal }).catch(() => {});
      }
    });
  } finally {
    health.ready = false; health.code = "stopped";
    unsubscribe();
    await watcher.disconnected();
    await pool.close();
  }
}
