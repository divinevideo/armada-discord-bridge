import postgres from "postgres";
import type { CommunityV2 } from "@armada-bridge/concord-core";
import type { LocalIdentity } from "../../bridge/src/concord/signer";
import { rehydrateCommunity } from "@armada-bridge/concord-core";
import { localIdentity } from "../../bridge/src/concord/signer";
import { RelayPool } from "../../bridge/src/concord/pool";
import { loadCommunityOrgs } from "./config";
import { ConcordActions } from "./concordActions";
import { Decisions } from "./decisions";
import { EvidenceCipher } from "./evidence";
import { PolicyStore } from "./policyStore";
import { PolicyWatcher } from "./policyWatcher";
import { assertPilotPublicationProvenance, publicationBlockers, recoverPublication, type RecoveryRequest } from "./publicationRecovery";

/** recoverPublication invokes authority only while holding controller and
 * execution ownership. Proof must not open admission; replay may refresh an
 * eligible pilot exactly as the ordinary worker does. Guard every refresh. */
export function createPublicationRecoveryActions(options: { sql: postgres.Sql; community: CommunityV2; identity: LocalIdentity; store: PolicyStore; relay: Pick<RelayPool, "queryStrict">; operation: RecoveryRequest["operation"] }): ConcordActions {
  const { sql, community, identity, store, relay, operation } = options;
  const watcher = new PolicyWatcher(community, store, relay, [identity.pk], identity, { readOnly: operation === "prove" });
  return new ConcordActions(community, identity, async () => {
    if (operation === "replay") await assertPilotPublicationProvenance(sql, community.idHex);
    return watcher.refresh();
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
