import { strict as assert } from "node:assert";
import { randomBytes, createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type postgres from "postgres";
import type { NostrEvent } from "nostr-tools/pure";
import { toJoinMaterial, wrapSeal } from "@armada-bridge/concord-core";
import { signCoopRequest } from "../../packages/moderation/src/api";
import { migrate } from "../../packages/bridge/src/db/migrate";
import type { moderationFixture } from "./moderation-events";
export async function exerciseModerationRuntime(options: { docker(...args: string[]): Promise<string>; directory: string; databaseUrl: string; sql: postgres.Sql; fixture: Awaited<ReturnType<typeof moderationFixture>>; instance: { name: string; url: string }; publisher: { publish(event: NostrEvent): Promise<boolean>; query(ids: string[]): Promise<NostrEvent[]> } }) {
  const { docker, directory, sql, fixture: f, instance, publisher } = options;
  await migrate(options.databaseUrl);
  for (const event of f.policy.controlEvents) assert.equal(await publisher.publish(event), true);
  const key = randomBytes(32), material = toJoinMaterial(f.community);
  const entry = join(directory, "synthetic-community.json");
  await writeFile(entry, JSON.stringify({ community_id: f.community.idHex, seed: material, current: material, added_at: Date.now() }), { mode: 0o600 });
  await docker("cp", entry, `${instance.name}:/data/community.json`);
  // The API's background handoff must not contact an ambient/external service.
  // A fresh test CA and mock live only in this owned relay container.
  const tlsKey = join(directory, "synthetic-coop-key.pem"), tlsCert = join(directory, "synthetic-coop-cert.pem");
  const certificate = Bun.spawn(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", tlsKey, "-out", tlsCert, "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdout: "ignore", stderr: "pipe" });
  await new Response(certificate.stderr).text();
  assert.equal(await certificate.exited, 0, "Synthetic Coop TLS provisioning failed");
  await docker("cp", tlsKey, `${instance.name}:/data/synthetic-coop-key.pem`);
  await docker("cp", tlsCert, `${instance.name}:/data/synthetic-coop-cert.pem`);
  await docker("exec", "--user", "0", instance.name, "chown", "10001:10001", "/data/synthetic-coop-key.pem", "/data/synthetic-coop-cert.pem");
  await docker("exec", "-d", instance.name, "bun", "-e", `Bun.serve({hostname:"127.0.0.1",port:8182,tls:{key:Bun.file("/data/synthetic-coop-key.pem"),cert:Bun.file("/data/synthetic-coop-cert.pem")},async fetch(request){if(new URL(request.url).pathname==="/healthz")return new Response("ok");const value=await request.json();return Response.json({caseId:value.caseId,state:"queued"},{status:202});}});`);
  await docker("exec", "-e", "NODE_EXTRA_CA_CERTS=/data/synthetic-coop-cert.pem", instance.name, "bun", "-e", `let ready=false;for(let i=0;i<50;i++){try{if((await fetch("https://127.0.0.1:8182/healthz")).ok){ready=true;break;}}catch{}await Bun.sleep(100);}if(!ready)throw new Error("Owned Coop TLS mock unavailable");`);
  const config = {
    MODERATION_DATABASE_URL: "postgres://bridge@pg/bridge", MODERATION_PUBLIC_ORIGIN: "https://moderation.example",
    MODERATION_COMMUNITY_ORGS: JSON.stringify({ [f.community.idHex]: "synthetic" }), MODERATION_COOP_HMAC_KEY: key.toString("hex"), MODERATION_EVIDENCE_KEY: randomBytes(32).toString("hex"),
    MODERATION_EVIDENCE_RETENTION_SECONDS: "3600", MODERATION_EVIDENCE_MAX_BYTES: "100000", MODERATION_EVIDENCE_MAX_CASES: "100", MODERATION_REPORT_ORIGINS: "[]",
    MODERATION_COOP_ORIGIN: "https://127.0.0.1:8182", MODERATION_COOP_API_KEY: "synthetic-api-key", MODERATION_COOP_ORG_ID: "synthetic", NODE_EXTRA_CA_CERTS: "/data/synthetic-coop-cert.pem",
    MODERATION_LOCAL_RELAY_URL: "ws://127.0.0.1:7777", MODERATION_COMMUNITY_ENTRY_FILE: "/data/community.json", MODERATION_MEMBER_KEY: Buffer.from(f.moderatorKey).toString("hex"),
    MODERATION_PUBLIC_AUTHORS: JSON.stringify([f.member.pk]), MODERATION_BRIDGE_TENANT_ID: "default", BRIDGE_MASTER_SECRET: randomBytes(32).toString("hex"), DISCORD_TOKEN: "synthetic-unused",
    BRIDGE_MODE: "public",
    BRIDGE_PUBLIC_CHANNELS: JSON.stringify({ guildId: "100000000000000000", channelIds: ["100000000000000001"], excludedCategoryIds: ["100000000000000002"] }),
  };
  const envPath = join(directory, "synthetic.env");
  await writeFile(envPath, Object.entries(config).map(([name, value]) => `${name}='${value}'`).join("\n"), { mode: 0o600 });
  await docker("cp", envPath, `${instance.name}:/data/moderation.env`);
  await docker("exec", "--user", "0", instance.name, "chown", "10001:10001", "/data/moderation.env", "/data/community.json");
  for (const [mode, port] of [["worker", "8081"], ["api", "8080"]]) await docker("exec", "-d", "-e", `MODERATION_MODE=${mode}`, "-e", `MODERATION_PORT=${port}`, "-e", "NODE_EXTRA_CA_CERTS=/data/synthetic-coop-cert.pem", instance.name, "bun", "--env-file=/data/moderation.env", "packages/moderation/src/index.ts");
  const apiPort = (await docker("port", instance.name, "8080/tcp")).split(":").at(-1);
  const workerPort = (await docker("port", instance.name, "8081/tcp")).split(":").at(-1);
  const origin = `http://127.0.0.1:${apiPort}`;
  const deadline = Date.now() + 25_000;
  for (const port of [apiPort, workerPort]) while (true) {
    try { if ((await fetch(`http://127.0.0.1:${port}/readyz`)).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error("Moderation process did not become ready");
    await Bun.sleep(100);
  }
  const body = JSON.stringify({ target: f.decision.target, reason: "Synthetic runtime report" });
  const auth = await f.member.signer.signEvent({ kind: 27235, content: "", tags: [["u", "https://moderation.example/v1/reports"], ["method", "POST"], ["payload", createHash("sha256").update(body).digest("hex")]], created_at: Math.floor(Date.now() / 1000) });
  const response = await fetch(origin + "/v1/reports", { method: "POST", headers: { authorization: `Nostr ${Buffer.from(JSON.stringify(auth)).toString("base64")}` }, body });
  assert.equal(response.status, 202);
  const { caseId } = await response.json() as { caseId: string };
  const handoffDeadline = Date.now() + 15_000;
  while (!(await sql`SELECT 1 FROM moderation.coop_handoffs WHERE case_id = ${caseId} AND state = 'queued'`).length) {
    if (Date.now() > handoffDeadline) throw new Error("Owned Coop mock did not acknowledge the case");
    await Bun.sleep(100);
  }
  const actor = { orgId: "synthetic", actorId: "synthetic-staff", permissions: ["view", "remove_message", "ban_member", "unban_member"] };
  let sourceRevision = 0;
  async function decide(action: string) {
    const body = JSON.stringify({ ...(action === "remove_message" ? {} : { sourceOrder: { version: 1, revision: String(++sourceRevision) } }), caseId, executionId: crypto.randomUUID(), action, reason: "Synthetic runtime decision", scope: action === "remove_message" ? "message" : "community", discordGuildConfirmed: false });
    const reply = await fetch(origin + "/v1/decisions", { method: "POST", headers: signCoopRequest(key, actor, "POST", "/v1/decisions", body), body });
    assert.equal(reply.status, 202);
    const { decisionId } = await reply.json() as { decisionId: string };
    const until = Date.now() + 30_000;
    while (true) {
      const path = `/v1/decisions/${decisionId}`;
      const status = await fetch(origin + path, { headers: signCoopRequest(key, actor, "GET", path, "") });
      assert.equal(status.status, 200);
      const outcome = await status.json() as { deliveries: { target: string; state: string; resultCode: string }[] };
      if (outcome.deliveries.some((d) => d.state === "failed")) throw new Error(`Runtime delivery failed: ${outcome.deliveries.map((d) => `${d.target}:${d.resultCode}`).join(",")}`);
      if (outcome.deliveries.every((d) => ["verified", "not_applicable"].includes(d.state))) break;
      if (Date.now() > until) throw new Error("Runtime delivery did not finish");
      await Bun.sleep(100);
    }
  }
  await decide("ban_member");
  assert.equal(await publisher.publish(wrapSeal(f.allowedSeal, f.chatKey)), false);
  await decide("unban_member");
  const alternative = wrapSeal(f.allowedSeal, f.chatKey);
  assert.equal(await publisher.publish(alternative), true);
  await decide("remove_message");
  assert.equal((await publisher.query([f.allowed.id, alternative.id])).length, 0);
  assert.equal(await publisher.publish(wrapSeal(f.allowedSeal, f.chatKey)), false);
  const [count] = await sql`SELECT count(*)::int AS n FROM moderation.decisions`;
  assert.equal(count.n, 3);
  console.log("PASS runtime: authenticated report → staff ban/unban/removal → independent verified relay/Concord results, no guessed Discord mapping, raw replay rejected");
}
