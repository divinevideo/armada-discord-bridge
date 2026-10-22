import postgres from "postgres";
import type { CommunityV2 } from "@armada-bridge/concord-core";
import type { LocalIdentity } from "../../bridge/src/concord/signer";
import { rehydrateCommunity, registerStreamKeys, controlGroups, guestbookGroups, baseRekeyGroupKey, channelsView } from "@armada-bridge/concord-core";
import { localIdentity } from "../../bridge/src/concord/signer";
import { RelayPool } from "../../bridge/src/concord/pool";
import { loadCommunityOrgs } from "./config";
import { ConcordActions } from "./concordActions";
import { Decisions } from "./decisions";
import { EvidenceCipher } from "./evidence";
import { PolicyStore } from "./policyStore";
import { PolicyWatcher } from "./policyWatcher";
import { loadPublicCapacity, PublicCapacityStore } from "./publicCapacity";
import { controlState } from "./relayPolicy";
import { assertPilotPublicationProvenance, publicationBlockers, recoverPublication, type RecoveryRequest } from "./publicationRecovery";

/** recoverPublication invokes authority only while holding controller and
 * execution ownership. Proof must not open admission; replay may refresh an
 * eligible pilot exactly as the ordinary worker does. Guard every refresh. */
export function createPublicationRecoveryActions(options: { sql: postgres.Sql; community: CommunityV2; identity: LocalIdentity; store: PolicyStore; relay: Pick<RelayPool, "queryStrict"> & Partial<Pick<RelayPool, "urls">>; operation: RecoveryRequest["operation"]; capacity?: ReturnType<typeof loadPublicCapacity> }): ConcordActions {
  const { sql, community, identity, store, relay, operation } = options;
  if (relay.urls?.length) registerStreamKeys([...controlGroups(community), ...guestbookGroups(community), ...community.heldRoots.map(root => baseRekeyGroupKey(root.key, community.id, root.epoch + 1n))], relay.urls);
  const watcher = new PolicyWatcher(community, store, relay, [identity.pk], identity, { readOnly: operation === "prove" });
  return new ConcordActions(community, identity, async () => {
    const capacity = operation === "replay" ? options.capacity ?? loadPublicCapacity() : undefined;
    const orgId = capacity?.communities.get(community.idHex);
    if (operation === "replay") {
      await assertPilotPublicationProvenance(sql, community.idHex);
      if (!orgId) throw new Error("Capacity community scope unavailable");
      if (!capacity?.contract) throw new Error("Reviewed capacity contract required for replay");
    }
    const policy = await watcher.refresh();
    if (capacity && orgId) {
      // The normal worker is stopped during maintenance. Reproduce its fresh
      // observation under the same authority/ownership path; never waive the
      // validator's sample-age check or clear its durable pause/contract hash.
      const observed = await new PublicCapacityStore(sql, capacity.contract).observeCurrent(orgId, community.idHex);
      if (observed.state === "unknown") throw new Error("Capacity observation unavailable");
      if (relay.urls?.length) registerStreamKeys(channelsView(community, controlState(policy).folded).flatMap(channel => channel.streams.map(stream => stream.group)), relay.urls);
    }
    return policy;
  });
}

async function main() {
  const [operation, communityId, requestFile, actorFile] = process.argv.slice(2);
  if (!["status", "preflight", "recover"].includes(operation ?? "") || !/^[0-9a-f]{64}$/.test(communityId ?? "")) throw Error("Usage: publicationOperator.ts status|preflight|recover communityId [request.json actor.json]");
  const communities = loadCommunityOrgs(process.env);
  if (communities.size !== 1 || !communities.has(communityId!)) throw Error("Single approved public pilot scope required");
  if (!process.env.MODERATION_DATABASE_URL) throw Error("Operator database required");
  const sql = postgres(process.env.MODERATION_DATABASE_URL, { max: 5, onnotice() {} });
  let pool: RelayPool | undefined;
  try {
    if (operation === "preflight") { await assertPilotPublicationProvenance(sql, communityId!); console.log(JSON.stringify({ eligible: true })); return; }
    if (operation === "status") { console.log(JSON.stringify(await publicationBlockers(sql, communityId!))); return; }
    if (!requestFile || !actorFile) throw Error("Recovery request and operator audit identity files required");
    const request: RecoveryRequest = await Bun.file(requestFile).json();
    const community = rehydrateCommunity(await Bun.file(process.env.MODERATION_COMMUNITY_ENTRY_FILE ?? "").json());
    if (!community || community.idHex !== communityId || community.privateChannels.length) throw Error("Approved public pilot entry required");
    const key = process.env.MODERATION_MEMBER_KEY ?? "", evidenceKey = process.env.MODERATION_EVIDENCE_KEY ?? "";
    if (!/^[0-9a-f]{64}$/.test(key) || !/^[0-9a-f]{64}$/.test(evidenceKey)) throw Error("Member and audit encryption provisioning required");
    const relayUrl = new URL(process.env.MODERATION_LOCAL_RELAY_URL ?? "");
    if (relayUrl.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(relayUrl.hostname)) throw Error("Local relay required");
    pool = new RelayPool([relayUrl.href]);
    const identity = localIdentity(Buffer.from(key, "hex"));
    const actions = createPublicationRecoveryActions({ sql, community, identity, store: new PolicyStore(sql), relay: pool, operation: request.operation });
    const cipher = new EvidenceCipher(Buffer.from(evidenceKey, "hex"), 1, 100_000);
    const decisions = new Decisions(sql, cipher, communities);
    console.log(JSON.stringify(await recoverPublication({ sql, decisions, cipher, actions, relay: pool,
      actor: await Bun.file(actorFile).json(), request })));
  } finally { await pool?.close(); await sql.end(); }
}
if (import.meta.main) await main().catch(error => { console.error(error.message); process.exitCode = 1; });
