import { createHash } from "node:crypto";
import type postgres from "postgres";
import type { VerifiedCoopActor } from "./decisions";
import type { RoomTarget } from "./contracts";
import { EvidenceCipher, type VerifiedEvidence } from "./evidence";
import { HEX_ID, verifiedEvent } from "./relayPolicy";
export interface VerifiedReporter { pubkey: string; authEventId: string }
export async function authenticateReport(request: Request, body: string, origin: string): Promise<VerifiedReporter> {
  const value = request.headers.get("authorization") ?? "";
  if (!value.startsWith("Nostr ") || value.length > 16_384) throw new Error("Report authentication required");
  const event = verifiedEvent(JSON.parse(Buffer.from(value.slice(6), "base64").toString("utf8")));
  const url = new URL(request.url);
  const tag = (name: string) => { const tags = event.tags.filter((t) => t[0] === name); if (tags.length !== 1 || tags[0].length !== 2) throw new Error("Invalid authentication binding"); return tags[0][1]; };
  if (event.kind !== 27235 || event.content !== "" || Math.abs(Date.now() / 1000 - event.created_at) > 60 || tag("u") !== origin + url.pathname + url.search || tag("method") !== request.method || tag("payload") !== createHash("sha256").update(body).digest("hex")) throw new Error("Invalid report authentication");
  return { pubkey: event.pubkey, authEventId: event.id };
}
export class Reports {
  constructor(private readonly sql: postgres.Sql, private readonly cipher: EvidenceCipher, private readonly resolver: { resolve(target: RoomTarget): Promise<VerifiedEvidence> }, private readonly communities: ReadonlyMap<string, string>, private readonly maxCases: number) {
    if (!Number.isSafeInteger(maxCases) || maxCases < 1) throw new Error("Bounded evidence capacity required");
  }
  async submitReport(input: { target: RoomTarget; reason: string }, reporter: VerifiedReporter): Promise<{ caseId: string }> {
    if (!input || Object.keys(input).sort().join(",") !== "reason,target" || !input.target || Object.keys(input.target).sort().join(",") !== "channelId,communityId,rumorId" || !Object.values(input.target).every((id) => typeof id === "string" && HEX_ID.test(id)) || typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 2048 || !HEX_ID.test(reporter.pubkey) || !HEX_ID.test(reporter.authEventId)) throw new Error("Invalid report");
    const org = this.communities.get(input.target.communityId);
    if (!org) throw new Error("Community not reportable");
    await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${reporter.pubkey}, 483212))`;
      await tx`DELETE FROM moderation.report_auth WHERE expires_at <= clock_timestamp()`;
      const [usage] = await tx`SELECT count(*)::int AS count FROM moderation.report_auth WHERE reporter = ${reporter.pubkey}`;
      if (usage.count >= 10) throw new Error("Report rate limit exceeded");
      const rows = await tx`INSERT INTO moderation.report_auth (event_id, reporter, expires_at) VALUES (${reporter.authEventId}, ${reporter.pubkey}, clock_timestamp() + interval '2 minutes') ON CONFLICT DO NOTHING RETURNING event_id`;
      if (!rows.length) throw new Error("Report authentication replayed");
    });
    const fingerprint = createHash("sha256").update(JSON.stringify([org, input.target.communityId, input.target.channelId, input.target.rumorId, reporter.pubkey])).digest("hex");
    const existing = await this.sql`SELECT case_id FROM moderation.cases WHERE fingerprint = ${fingerprint} AND expires_at > clock_timestamp()`;
    if (existing.length) return { caseId: existing[0].case_id };
    const evidence = await this.resolver.resolve(input.target);
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${org}, 483211))`;
      await tx`DELETE FROM moderation.cases WHERE expires_at <= clock_timestamp()`;
      const [duplicate] = await tx`SELECT case_id FROM moderation.cases WHERE fingerprint = ${fingerprint}`;
      if (duplicate) return { caseId: duplicate.case_id as string };
      const [count] = await tx`SELECT count(*)::int AS count FROM moderation.cases WHERE org_id = ${org}`;
      if (count.count >= this.maxCases) throw new Error("Evidence capacity reached");
      const caseId = crypto.randomUUID();
      const encrypted = this.cipher.seal(`${org}:${caseId}`, { evidence, reporter: reporter.pubkey, reason: input.reason });
      await tx`INSERT INTO moderation.cases (case_id, org_id, community_id, channel_id, rumor_id, author, fingerprint, evidence, expires_at)
        VALUES (${caseId}, ${org}, ${input.target.communityId}, ${input.target.channelId}, ${input.target.rumorId}, ${evidence.author}, ${fingerprint}, ${encrypted}, ${new Date(Date.now() + this.cipher.retentionSeconds * 1000)})`;
      return { caseId };
    });
  }
  async getCase(caseId: string, actor: VerifiedCoopActor) {
    if (!actor.actorId || !actor.permissions.includes("view") || !/^[0-9a-f-]{36}$/.test(caseId)) throw new Error("Case unavailable");
    const [row] = await this.sql`SELECT * FROM moderation.cases WHERE case_id = ${caseId} AND org_id = ${actor.orgId} AND expires_at > clock_timestamp()`;
    if (!row || this.communities.get(row.community_id) !== actor.orgId) throw new Error("Case unavailable");
    const value = this.cipher.open(`${actor.orgId}:${caseId}`, row.evidence);
    return { caseId, target: { communityId: row.community_id as string, channelId: row.channel_id as string, rumorId: row.rumor_id as string }, author: row.author as string, content: value.evidence.content as string, reason: value.reason as string, createdAt: value.evidence.createdAt as number, ...(value.evidence.editedAt === undefined ? {} : { editedAt: value.evidence.editedAt as number }), expiresAt: (row.expires_at as Date).toISOString() };
  }
  async expire(): Promise<void> { await this.sql`DELETE FROM moderation.cases WHERE expires_at <= clock_timestamp()`; await this.sql`DELETE FROM moderation.report_auth WHERE expires_at <= clock_timestamp()`; }
}
