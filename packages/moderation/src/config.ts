export function loadModerationConfig(env: Record<string, string | undefined>) {
  const required = (name: string) => { const value = env[name]; if (!value) throw new Error(`Missing ${name}`); return value; };
  const positive = (name: string) => { const value = required(name); if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`Invalid ${name}`); return Number(value); };
  const secret = (name: string) => { const value = required(name); if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`Invalid ${name}`); return Buffer.from(value, "hex"); };
  const origin = new URL(required("MODERATION_PUBLIC_ORIGIN"));
  if (origin.protocol !== "https:" || origin.origin !== origin.href.slice(0, -1)) throw new Error("Invalid MODERATION_PUBLIC_ORIGIN");
  const communities = new Map<string, string>(Object.entries(JSON.parse(required("MODERATION_COMMUNITY_ORGS"))));
  if (!communities.size || [...communities].some(([id, org]) => !/^[0-9a-f]{64}$/.test(id) || typeof org !== "string" || !org || org.length > 128)) throw new Error("Invalid MODERATION_COMMUNITY_ORGS");
  const allowedReportOrigins = new Set<string>(JSON.parse(required("MODERATION_REPORT_ORIGINS")));
  if ([...allowedReportOrigins].some((value) => typeof value !== "string" || new URL(value).protocol !== "https:" || new URL(value).origin !== value)) throw new Error("Invalid MODERATION_REPORT_ORIGINS");
  return { allowedReportOrigins, databaseUrl: required("MODERATION_DATABASE_URL"), publicOrigin: origin.origin, communities, coopSecret: secret("MODERATION_COOP_HMAC_KEY"), evidenceKey: secret("MODERATION_EVIDENCE_KEY"), evidenceRetentionSeconds: positive("MODERATION_EVIDENCE_RETENTION_SECONDS"), evidenceMaxBytes: positive("MODERATION_EVIDENCE_MAX_BYTES"), evidenceMaxCases: positive("MODERATION_EVIDENCE_MAX_CASES") };
}
