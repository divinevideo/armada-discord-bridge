import { strict as assert } from "node:assert";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { buildRumor, channelBindingTags, sealRumor, wrapSeal, KIND_SEAL_ENCRYPTED } from "@armada-bridge/concord-core";
import type { NostrEvent } from "nostr-tools/pure";
import { relayFixture } from "./relay-events";
import { PolicyStore, migrateModeration } from "../../packages/moderation/src/policyStore";

const label = `divine-relay-policy-${process.pid}`;
const directory = await mkdtemp(join(tmpdir(), label));
const containers: string[] = [];
const sockets: WebSocket[] = [];
let sql: postgres.Sql | undefined;
async function docker(...args: string[]): Promise<string> {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exit) throw new Error(`Docker ${args[0]} failed: ${err}`);
  return (args[0] === "logs" ? out + err : out).trim();
}
function waitFor<T>(check: () => T | undefined, ms = 6000): Promise<T> {
  const start = performance.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const result = check();
      if (result !== undefined) { clearInterval(timer); resolve(result); }
      else if (performance.now() - start > ms) { clearInterval(timer); reject(new Error("Relay test deadline exceeded")); }
    }, 10);
  });
}
async function connect(url: string) {
  const ws = new WebSocket(url);
  sockets.push(ws);
  const messages: any[][] = [];
  ws.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data))));
  await new Promise<void>((resolve, reject) => { ws.addEventListener("open", () => resolve()); ws.addEventListener("error", () => reject(new Error("Relay connection failed"))); });
  return {
    ws, messages,
    async publish(event: NostrEvent) {
      ws.send(JSON.stringify(["EVENT", event]));
      return waitFor(() => messages.find((m) => m[0] === "OK" && m[1] === event.id)?.[2] as boolean | undefined);
    },
    async query(ids: string[]) {
      const subscription = crypto.randomUUID();
      ws.send(JSON.stringify(["REQ", subscription, { ids }]));
      await waitFor(() => messages.some((m) => m[0] === "EOSE" && m[1] === subscription) ? true : undefined);
      ws.send(JSON.stringify(["CLOSE", subscription]));
      return messages.filter((m) => m[0] === "EVENT" && m[1] === subscription).map((m) => m[2]);
    },
  };
}
async function relay(mode: string) {
  const name = `${label}-${mode}`;
  const plugin = mode === "normal" ? "/usr/local/bin/relay-policy" : mode === "missing" ? "" : "/data/fault.sh";
  const config = `db = "/data/db/"\nrelay { bind = "0.0.0.0" port = 7777 auth { enabled = true serviceUrl = "wss://relay.example" } writePolicy { plugin = "${plugin}" timeoutSeconds = 3 } logging { dumpInAll = false dumpInEvents = false dumpInReqs = false invalidEvents = false } }\n`;
  const configPath = join(directory, `${mode}.conf`);
  await writeFile(configPath, config, { mode: 0o644 });
  const args = ["run", "-d", "--name", name, "--network", label, "-p", "127.0.0.1::7777", "-e", "MODERATION_DATABASE_URL=postgres://bridge@pg/bridge", "-v", `${configPath}:/data/strfry.conf:ro`];
  if (mode !== "normal") {
    const fault = join(directory, `${mode}.sh`);
    const body = mode === "timeout" ? "sleep 10" : mode === "malformed" ? 'IFS= read -r request\nprintf "invalid %s\\n" "$request"' : "exit 1";
    await writeFile(fault, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    args.push("-v", `${fault}:/data/fault.sh:ro`);
  }
  args.push(process.env.STRFRY_TEST_IMAGE!);
  await docker(...args);
  containers.push(name);
  const port = (await docker("port", name, "7777/tcp")).split(":").at(-1);
  const url = `ws://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (true) {
    try { await fetch(`http://127.0.0.1:${port}`); break; }
    catch { if (Date.now() > deadline) throw new Error(`Relay ${mode} did not become ready: ${await docker("logs", name)}`); await Bun.sleep(100); }
  }
  return { name, url };
}
try {
  await docker("network", "create", label);
  const dbName = label + "-db";
  await docker("run", "-d", "--name", dbName, "--network", label, "--network-alias", "pg", "-p", "127.0.0.1::5432", "-e", "POSTGRES_USER=bridge", "-e", "POSTGRES_DB=bridge", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:16@sha256:a3b7f434b2dc57ce85a67e171163eb8ab1a1ebcb39d27484661f26b1dfbe30d6");
  containers.push(dbName);
  for (let attempt = 0; ; attempt++) {
    try { await docker("exec", dbName, "pg_isready", "-h", "127.0.0.1", "-U", "bridge"); break; }
    catch { if (attempt >= 100) throw new Error("Test database not ready"); await Bun.sleep(100); }
  }
  const dbPort = (await docker("port", dbName, "5432/tcp")).split(":").at(-1);
  sql = postgres(`postgres://bridge@127.0.0.1:${dbPort}/bridge`, { onnotice: () => {} });
  await migrateModeration(sql);
  const fixture = await relayFixture();
  const store = new PolicyStore(sql);
  await store.install(fixture.policy, [fixture.chatStream, fixture.controlStream, fixture.guestbookStream], 0);
  const normal = await relay("normal");
  const publisher = await connect(normal.url), subscriber = await connect(normal.url);
  subscriber.ws.send(JSON.stringify(["REQ", "live", { authors: [fixture.chatKey.pk] }]));
  await waitFor(() => subscriber.messages.some((m) => m[0] === "EOSE") ? true : undefined);
  assert.equal(await publisher.publish(fixture.allowed), true);
  await waitFor(() => subscriber.messages.find((m) => m[0] === "EVENT" && m[2].id === fixture.allowed.id));
  const authClient = await connect(normal.url);
  const protectedProfile = await fixture.member.signer.signEvent({ kind: 0, content: "{}", tags: [["-"]], created_at: Math.floor(Date.now() / 1000) });
  authClient.ws.send(JSON.stringify(["EVENT", protectedProfile]));
  const challenge = await waitFor(() => authClient.messages.find((m) => m[0] === "AUTH")?.[1]);
  const auth = await fixture.member.signer.signEvent({ kind: 22242, content: "", tags: [["relay", "wss://relay.example"], ["challenge", challenge]], created_at: Math.floor(Date.now() / 1000) });
  authClient.ws.send(JSON.stringify(["AUTH", auth]));
  assert.equal(await waitFor(() => authClient.messages.find((m) => m[0] === "OK" && m[1] === auth.id)?.[2]), true);
  assert.equal(await authClient.publish(fixture.banned), false);
  assert.equal(await publisher.publish(fixture.banned), false);
  assert.equal((await publisher.query([fixture.banned.id])).length, 0);
  assert.equal(subscriber.messages.some((m) => m[0] === "EVENT" && m[2].id === fixture.banned.id), false);
  const typing = buildRumor({ pubkey: fixture.bannedMember.pk, kind: 23311, content: "", tags: channelBindingTags(fixture.channelId, 0n), ms: Date.now() });
  const ephemeral = wrapSeal(await sealRumor(typing, KIND_SEAL_ENCRYPTED, fixture.chatKey, fixture.bannedMember.signer), fixture.chatKey, { ephemeral: true });
  assert.equal(await publisher.publish(ephemeral), false);
  assert.equal((await publisher.query([ephemeral.id])).length, 0);
  assert.equal(subscriber.messages.some((m) => m[0] === "EVENT" && m[2].id === ephemeral.id), false);
  await store.setBan(fixture.policy.communityId, fixture.member.pk, true);
  const afterBan = wrapSeal(fixture.allowedSeal, fixture.chatKey);
  assert.equal(await publisher.publish(afterBan), false);
  assert.equal((await publisher.query([afterBan.id])).length, 0);
  await sql`UPDATE moderation.community_policy SET payload = jsonb_set(payload, '{validUntil}', '0') WHERE community_id = ${fixture.policy.communityId}`;
  const ownerChat = buildRumor({ pubkey: fixture.owner.pk, kind: 9, content: "synthetic owner freshness test", tags: channelBindingTags(fixture.channelId, 0n), ms: Date.now() });
  const stalePolicyEvent = wrapSeal(await sealRumor(ownerChat, KIND_SEAL_ENCRYPTED, fixture.chatKey, fixture.owner.signer), fixture.chatKey);
  assert.equal(await publisher.publish(stalePolicyEvent), false);
  assert.equal((await publisher.query([stalePolicyEvent.id])).length, 0);
  console.log("PASS raw relay: allowed member delivered; banned author, alternate wrapper and ephemeral traffic rejected without fan-out or storage");
  for (const mode of ["timeout", "malformed", "crash", "missing"]) {
    const instance = await relay(mode);
    const client = await connect(instance.url);
    const event = wrapSeal(fixture.allowedSeal, fixture.chatKey);
    assert.equal(await client.publish(event), false);
    assert.equal((await client.query([event.id])).length, 0);
    const logs = await docker("logs", instance.name);
    assert.equal(logs.includes(event.content), false);
    assert.equal(logs.includes("sourceInfo"), false);
    assert.equal(/Connect from|Disconnect from/.test(logs), false, "Source addresses must not enter relay logs");
    console.log(`PASS real strfry ${mode}: rejected and absent; logs contain no request payload or source address`);
  }
  console.log(`PASS tested image ${process.env.STRFRY_TEST_IMAGE}`);
} finally {
  for (const ws of sockets) ws.close();
  if (sql) await sql.end();
  for (const name of containers.reverse()) await docker("rm", "-f", name).catch(() => {});
  await docker("network", "rm", label).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
