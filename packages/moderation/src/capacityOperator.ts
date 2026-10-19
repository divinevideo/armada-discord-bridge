import postgres from "postgres";
import { loadPublicCapacity, PublicCapacityStore } from "./publicCapacity";

/** Local operator command: database credentials remain the existing authority boundary. */
async function main(): Promise<void> {
  const [action, communityId, actorOrReason, contractHash] = process.argv.slice(2);
  if (!["observe", "pause", "resume"].includes(action ?? "") || !/^[0-9a-f]{64}$/.test(communityId ?? "")) throw Error("Usage: capacityOperator.ts observe|pause|resume communityId [reasonCode|actorId] [contractHash]");
  const capacity = loadPublicCapacity(), orgId = capacity.communities.get(communityId!);
  if (!orgId || !process.env.MODERATION_DATABASE_URL) throw Error("Operator database and community scope required");
  const sql = postgres(process.env.MODERATION_DATABASE_URL, { onnotice() {} });
  try {
    const store = new PublicCapacityStore(sql, capacity.contract);
    const result = action === "resume" ? await store.resume({ orgId, communityId: communityId!, actorId: actorOrReason ?? "", contractHash: contractHash ?? "" })
      : action === "pause" ? await store.pause({ orgId, communityId: communityId!, reasonCode: actorOrReason ?? "" })
      : await store.observeCurrent(orgId, communityId!);
    console.log(JSON.stringify({ ...result, contractHash: store.contractHash }));
  } finally { await sql.end(); }
}
if (import.meta.main) await main();
