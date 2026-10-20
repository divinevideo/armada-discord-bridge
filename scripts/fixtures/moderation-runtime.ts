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
  const tlsConfig = join(directory, "synthetic-coop.cnf");
  await writeFile(tlsConfig, "[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=extensions\n[dn]\nCN=127.0.0.1\n[extensions]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n");
  const certificate = Bun.spawn(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", tlsKey, "-out", tlsCert, "-days", "1", "-config", tlsConfig], { stdout: "ignore", stderr: "pipe" });
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
    MODERATION_AUDIT_RETENTION_SECONDS: "60", MODERATION_HOLD_MAX_SECONDS: "3600", MODERATION_EVIDENCE_RETENTION_SECONDS: "3600", MODERATION_EVIDENCE_MAX_BYTES: "100000", MODERATION_EVIDENCE_MAX_CASES: "100", MODERATION_REPORT_ORIGINS: "[]",
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
  const workerLauncher = `import { runModerationService } from "/opt/divine/packages/moderation/src/index.ts"; const data = await Bun.file("/data/calibration.json").json(); console.error("CALIBRATION synthetic worker dependency injection; no launch proof"); await runModerationService({capacity:{communities:new Map(data.communities),contract:data.contract}});`;
  for (const [mode, port] of [["worker", "8081"], ["api", "8080"]]) {
    const command = mode === "worker" ? ["-e", workerLauncher] : ["packages/moderation/src/index.ts"];
    await docker("exec", "-d", "-e", `MODERATION_MODE=${mode}`, "-e", `MODERATION_PORT=${port}`, "-e", "NODE_EXTRA_CA_CERTS=/data/synthetic-coop-cert.pem", instance.name, "bun", "--env-file=/data/moderation.env", ...command);
  }
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
  let { caseId } = await response.json() as { caseId: string };
  const handoffDeadline = Date.now() + 15_000;
  while (!(await sql`SELECT 1 FROM moderation.coop_handoffs WHERE case_id = ${caseId} AND state = 'queued'`).length) {
    if (Date.now() > handoffDeadline) throw new Error("Owned Coop mock did not acknowledge the case");
    await Bun.sleep(100);
  }
  const actor = { orgId: "synthetic", actorId: "synthetic-staff", permissions: ["view", "remove_message", "ban_member", "unban_member", "manage_moderation_records", "view_held_evidence"] };
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
    return decisionId;
  }
  const banId = await decide("ban_member");
  assert.equal(await publisher.publish(wrapSeal(f.allowedSeal, f.chatKey)), false);
  const signed = async (path: string, input?: unknown) => {
    const body = input === undefined ? "" : JSON.stringify(input), method = input === undefined ? "GET" : "POST";
    const reply = await fetch(origin + path, { method, headers: signCoopRequest(key, actor, method, path, body), ...(input === undefined ? {} : { body }) });
    assert.equal(reply.headers.get("cache-control"), "no-store"); return reply;
  };
  assert.equal((await fetch(origin + "/write-readyz")).status, 200);
  const holdResponse = await signed(`/v1/cases/${caseId}/holds`, { reason: "Synthetic runtime hold", holdUntil: new Date(Date.now() + 120000).toISOString() });
  assert.equal(holdResponse.status, 201); const held = await holdResponse.json() as { holdId: string };
  await sql`UPDATE moderation.cases SET expires_at = clock_timestamp() - interval '1 second' WHERE case_id = ${caseId}`;
  await sql.begin(async tx => { await tx`SET LOCAL session_replication_role = replica`; await tx`UPDATE moderation.decisions SET expires_at = clock_timestamp() - interval '1 second' WHERE decision_id = ${banId}`; });
  assert.equal((await (await signed(`/v1/cases/${caseId}`)).json() as { evidenceAvailable: boolean }).evidenceAvailable, false);
  const heldView = await signed(`/v1/cases/${caseId}/held-evidence`, { reason: "Synthetic audited runtime access" }); assert.equal(heldView.status, 200);
  assert.equal(typeof (await heldView.json() as { content: string }).content, "string");
  const context = await signed(`/v1/decisions/${banId}/reversal-context`); assert.equal(context.status, 200);
  const reverse = await signed(`/v1/decisions/${banId}/reversals`, { executionId: crypto.randomUUID(), action: "unban_member", reason: "Synthetic fresh runtime reversal", scope: "community", discordGuildConfirmed: false, sourceOrder: { version: 1, revision: String(++sourceRevision) } });
  assert.equal(reverse.status, 202); const reversal = await reverse.json() as { decisionId: string };
  const reversalDeadline = Date.now() + 30000;
  while (true) {
    const status = await (await signed(`/v1/decisions/${reversal.decisionId}`)).json() as { deliveries: { state: string }[] };
    assert.equal(status.deliveries.some(d => d.state === "failed"), false);
    if (status.deliveries.every(d => ["verified", "not_applicable"].includes(d.state))) break;
    if (Date.now() > reversalDeadline) throw new Error("Fresh runtime reversal did not settle"); await Bun.sleep(100);
  }
  assert.equal((await signed(`/v1/holds/${held.holdId}/release`, { reason: "Synthetic runtime release" })).status, 200);
  assert.equal((await sql`SELECT 1 FROM moderation.cases WHERE case_id = ${caseId}`).length, 0);
  assert.equal((await signed(`/v1/decisions/${banId}/restriction-refresh`, {})).status, 202);
  const closeDeadline = Date.now() + 15000;
  while (true) {
    const reply = await signed(`/v1/decisions/${banId}/close`, { reason: "Synthetic settled native sanction" });
    if (reply.status === 200) break;
    if (Date.now() > closeDeadline) throw new Error("Verified native sanction could not close"); await Bun.sleep(100);
  }
  // A new report for removal is distinct from the expired source. Its evidence
  // resolves from the surviving publication; no old case bytes are restored.
  const freshBody = JSON.stringify({ target: f.decision.target, reason: "Synthetic runtime removal report" });
  const freshAuth = await f.member.signer.signEvent({ kind: 27235, content: "", tags: [["u", "https://moderation.example/v1/reports"], ["method", "POST"], ["payload", createHash("sha256").update(freshBody).digest("hex")]], created_at: Math.floor(Date.now() / 1000) });
  const freshReport = await fetch(origin + "/v1/reports", { method: "POST", headers: { authorization: `Nostr ${Buffer.from(JSON.stringify(freshAuth)).toString("base64")}` }, body: freshBody });
  assert.equal(freshReport.status, 202); caseId = (await freshReport.json() as { caseId: string }).caseId;
  const alternative = wrapSeal(f.allowedSeal, f.chatKey);
  assert.equal(await publisher.publish(alternative), true);
  await decide("remove_message");
  assert.equal((await publisher.query([f.allowed.id, alternative.id])).length, 0);
  assert.equal(await publisher.publish(wrapSeal(f.allowedSeal, f.chatKey)), false);
  const [count] = await sql`SELECT count(*)::int AS n FROM moderation.decisions`;
  assert.equal(count.n, 3);
  console.log("PASS runtime: authenticated report → timed hold/audited access → expired-source fresh reversal → explicit settled audit closure → new-report removal; independent relay/Concord proof, no guessed Discord mapping, raw replay rejected");
}
