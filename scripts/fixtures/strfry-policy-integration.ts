import { strict as assert } from "node:assert";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { buildRumor, channelBindingTags, sealRumor, wrapSeal, KIND_SEAL_ENCRYPTED } from "@armada-bridge/concord-core";
import type { NostrEvent } from "nostr-tools/pure";
import { relayFixture } from "./relay-events";
import { moderationFixture } from "./moderation-events";
import { exerciseModerationRuntime } from "./moderation-runtime";
import { capacityCalibrationLauncher } from "./strfry-capacity";
import { PublicCapacityStore } from "../../packages/moderation/src/publicCapacity";
import type { PublicCapacityContract } from "../../packages/moderation/src/capacityContract";
import { PolicyStore, migrateModeration } from "../../packages/moderation/src/policyStore";

const label = `divine-relay-policy-${process.pid}`;
const directory = await mkdtemp(join(tmpdir(), label));
const containers: string[] = [];
const sockets: WebSocket[] = [];
let snapshotImage: string | undefined;
let restoreFloors: Record<string, number> | undefined;
let sql: postgres.Sql | undefined;
// Explicit synthetic library input, deliberately invalid as deployed launch evidence.
const calibrationContract = { maxima: { historyCount: 4095, historyBytes: 10000000, rekeyCount: 256, streamCount: 1024, inFlight: 4, innerAdmissionMs: 1499 }, thresholds: { warningHistoryCount: 3000, pauseHistoryCount: 4000, urgentReserve: 16 }, maxSampleAgeMs: 120000 } as PublicCapacityContract;
const calibration = { contract: calibrationContract, communities: [] as Array<[string, string]> };
async function addCalibrationCommunity(communityId: string) {
  calibration.communities.push([communityId, "synthetic"]);
  await writeFile(join(directory, "calibration.json"), JSON.stringify(calibration), { mode: 0o644 });
  await new PublicCapacityStore(sql!, calibrationContract).observeCurrent("synthetic", communityId);
}
async function docker(...args: string[]): Promise<string> {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exit) throw new Error(`Docker ${args[0]} failed: ${err || (args.includes("packages/moderation/src/relayPurgeCli.ts") ? out : "")}`);
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
      const start = messages.length;
      ws.send(JSON.stringify(["EVENT", event]));
      return waitFor(() => messages.slice(start).find((m) => m[0] === "OK" && m[1] === event.id)?.[2] as boolean | undefined);
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
  const strict = mode.startsWith("strict-");
  const plugin = strict ? "/usr/local/bin/relay-policy" : ["normal", "restored"].includes(mode) ? "/data/calibration-policy.sh" : mode === "missing" ? "" : "/data/fault.sh";
  const config = `db = "/data/db/"\nrelay { nofiles = 0 bind = "0.0.0.0" port = 7777 auth { enabled = true serviceUrl = "wss://relay.example" } writePolicy { plugin = "${plugin}" timeoutSeconds = 3 } logging { dumpInAll = false dumpInEvents = false dumpInReqs = false invalidEvents = false } }\n`;
  const configPath = join(directory, `${mode}.conf`);
  await writeFile(configPath, config, { mode: 0o644 });
  const args = ["run", "-d", "--ulimit", "nofile=65536:65536", "--name", name, "--network", label, "-p", "127.0.0.1::7777", "-p", "127.0.0.1::8080", "-p", "127.0.0.1::8081", "-e", "MODERATION_DATABASE_URL=postgres://bridge@pg/bridge", "-v", `${configPath}:/data/strfry.conf:ro`];
  for (const file of ["calibration.json", "calibration-launcher.ts", "calibration-policy.sh", "invalid-capacity.json"]) args.push("-v", `${join(directory, file)}:/data/${file}:ro`);
  args.push("-e", `MODERATION_COMMUNITY_ORGS=${JSON.stringify(Object.fromEntries(calibration.communities))}`);
  if (mode === "strict-invalid") args.push("-e", "MODERATION_CAPACITY_CONTRACT_FILE=/data/invalid-capacity.json");
  if (!strict && !["normal", "restored"].includes(mode)) {
    const fault = join(directory, `${mode}.sh`);
    const body = mode === "race" ? 'while IFS= read -r request; do response="$(printf "%s\\n" "$request" | /data/calibration-policy.sh)"; touch /data/admitted; while [ ! -f /data/release ]; do sleep 0.02; done; printf "%s\\n" "$response"; done' : mode === "timeout" ? "sleep 10" : mode === "malformed" ? 'IFS= read -r request\nprintf "invalid %s\\n" "$request"' : "exit 1";
    await writeFile(fault, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    args.push("-v", `${fault}:/data/fault.sh:ro`);
  }
  if (mode === "restored") {
    args.push("-e", `MODERATION_RESTORE_REVISIONS=${JSON.stringify(restoreFloors)}`, "--entrypoint", "/bin/sh", snapshotImage!, "-c", "bun packages/moderation/src/offlineRelayRestore.ts && exec strfry --config=/data/strfry.conf relay");
  } else args.push(process.env.STRFRY_TEST_IMAGE!);
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
  const fixture = await moderationFixture();
  const store = new PolicyStore(sql);
  await store.install(fixture.policy, [fixture.chatStream, fixture.controlStream, fixture.guestbookStream], 0);
  await addCalibrationCommunity(fixture.community.idHex);
  await writeFile(join(directory, "calibration-launcher.ts"), capacityCalibrationLauncher("/data/calibration.json"), { mode: 0o644 });
  await writeFile(join(directory, "calibration-policy.sh"), "#!/bin/sh\nexec bun /data/calibration-launcher.ts\n", { mode: 0o755 });
  await writeFile(join(directory, "invalid-capacity.json"), JSON.stringify({ version: 1, synthetic: true }), { mode: 0o644 });
  for (const mode of ["strict-missing", "strict-invalid"]) {
    const instance = await relay(mode), writer = await connect(instance.url), reader = await connect(instance.url);
    reader.ws.send(JSON.stringify(["REQ", "strict-live", { authors: [fixture.chatKey.pk] }]));
    await waitFor(() => reader.messages.some(m => m[0] === "EOSE") ? true : undefined);
    const event = wrapSeal(fixture.allowedSeal, fixture.chatKey);
    assert.equal(await writer.publish(event), false);
    assert.equal((await writer.query([event.id])).length, 0);
    assert.equal(reader.messages.some(m => m[0] === "EVENT" && m[2].id === event.id), false);
    assert.equal((await sql`SELECT 1 FROM moderation.carriers WHERE event_id = ${event.id}`).length, 0);
    console.log(`PASS deployed entrypoint ${mode}: no acceptance, storage, fanout or admission database mutation`);
  }
  console.log("CALIBRATION synthetic library input only; positive runtime checks are not a measured launch contract");
  const normal = await relay("normal");
  const publisher = await connect(normal.url), subscriber = await connect(normal.url);
  subscriber.ws.send(JSON.stringify(["REQ", "live", { authors: [fixture.chatKey.pk] }]));
  await waitFor(() => subscriber.messages.some((m) => m[0] === "EOSE") ? true : undefined);
  assert.equal(await publisher.publish(fixture.allowed), true);
  await waitFor(() => subscriber.messages.find((m) => m[0] === "EVENT" && m[2].id === fixture.allowed.id));
  if (process.env.TEST_MODERATION_RUNTIME === "1") {
    await exerciseModerationRuntime({ docker, directory, databaseUrl: `postgres://bridge@127.0.0.1:${dbPort}/bridge`, sql, fixture, instance: normal, publisher });
  } else if (process.env.TEST_STRFRY_PURGE === "1") {
    const target = [fixture.policy.communityId, fixture.channelId, fixture.allowedRumorId];
    const second = wrapSeal(fixture.allowedSeal, fixture.chatKey);
    assert.equal(await publisher.publish(second), true);
    const editRumor = buildRumor({ pubkey: fixture.member.pk, kind: 3302, content: "Synthetic edited message", tags: [...channelBindingTags(fixture.channelId, 0n), ["e", fixture.allowedRumorId]], ms: Date.now() });
    const editSeal = await sealRumor(editRumor, KIND_SEAL_ENCRYPTED, fixture.chatKey, fixture.member.signer);
    const edit = wrapSeal(editSeal, fixture.chatKey), alternateEdit = wrapSeal(editSeal, fixture.chatKey);
    const reaction = wrapSeal(await sealRumor(buildRumor({ pubkey: fixture.member.pk, kind: 7, content: "+", tags: [...channelBindingTags(fixture.channelId, 0n), ["e", fixture.allowedRumorId]], ms: Date.now() }), KIND_SEAL_ENCRYPTED, fixture.chatKey, fixture.member.signer), fixture.chatKey);
    for (const event of [edit, alternateEdit, reaction]) assert.equal(await publisher.publish(event), true);
    const removedIds = [fixture.allowed.id, second.id, edit.id, alternateEdit.id, reaction.id];
    const unrelatedRumor = buildRumor({ pubkey: fixture.member.pk, kind: 9, content: "synthetic unrelated message", tags: channelBindingTags(fixture.channelId, 0n), ms: Date.now() });
    const unrelated = wrapSeal(await sealRumor(unrelatedRumor, KIND_SEAL_ENCRYPTED, fixture.chatKey, fixture.member.signer), fixture.chatKey);
    assert.equal(await publisher.publish(unrelated), true);
    // A synthetic-only paused container snapshot stands in for an older relay backup.
    snapshotImage = `${label}-snapshot`;
    await docker("commit", normal.name, snapshotImage);
    const decision = crypto.randomUUID();
    const purge = async (name: string, id: string) => JSON.parse(await docker("exec", name, "bun", "packages/moderation/src/relayPurgeCli.ts", id, ...target));
    assert.equal((await purge(normal.name, decision)).state, "verified");
    assert.equal((await publisher.query(removedIds)).length, 0);
    assert.equal((await publisher.query([unrelated.id])).length, 1);
    assert.equal(await publisher.publish(fixture.allowed), false);
    assert.equal(await publisher.publish(wrapSeal(fixture.allowedSeal, fixture.chatKey)), false);
    assert.equal(await publisher.publish(wrapSeal(editSeal, fixture.chatKey)), false);
    assert.equal(await publisher.publish(reaction), false);
    assert.equal((await purge(normal.name, decision)).state, "verified");
    await docker("restart", normal.name);
    const restartPort = (await docker("port", normal.name, "7777/tcp")).split(":").at(-1);
    const restartDeadline = Date.now() + 10_000;
    while (true) {
      try { await fetch(`http://127.0.0.1:${restartPort}`); break; }
      catch { if (Date.now() > restartDeadline) throw new Error("Relay did not restart"); await Bun.sleep(50); }
    }
    const restarted = await connect(`ws://127.0.0.1:${restartPort}`);
    assert.equal((await restarted.query(removedIds)).length, 0);
    assert.equal(await restarted.publish(wrapSeal(fixture.allowedSeal, fixture.chatKey)), false);
    assert.equal(await restarted.publish(wrapSeal(editSeal, fixture.chatKey)), false);
    console.log("PASS purge: all wrappers absent after removal/retry/restart, unrelated event remains, exact and alternate replay rejected");
    const [current] = await sql`SELECT revision FROM moderation.community_policy WHERE community_id = ${fixture.policy.communityId}`;
    restoreFloors = { [fixture.policy.communityId]: Number(current.revision) };
    const restoredInstance = await relay("restored");
    const restoredClient = await connect(restoredInstance.url);
    assert.equal((await restoredClient.query(removedIds)).length, 0);
    assert.equal((await restoredClient.query([unrelated.id])).length, 1);
    assert.equal(await restoredClient.publish(wrapSeal(fixture.allowedSeal, fixture.chatKey)), false);
    assert.equal(await restoredClient.publish(wrapSeal(editSeal, fixture.chatKey)), false);
    console.log("PASS restore: older relay snapshot reconciled before listening, removed carriers absent and unrelated message retained");

    // A second isolated community allows a deterministic accepted-but-uncommitted race.
    const racing = await relayFixture();
    await store.install(racing.policy, [racing.chatStream, racing.controlStream, racing.guestbookStream], 0);
    await addCalibrationCommunity(racing.community.idHex);
    const instance = await relay("race");
    const racer = await connect(instance.url);
    const publishing = racer.publish(racing.allowed);
    publishing.catch(() => {});
    const deadline = Date.now() + 5000;
    while (true) {
      try { await docker("exec", instance.name, "test", "-f", "/data/admitted"); break; }
      catch { if (Date.now() > deadline) throw new Error("Admission gate not reached"); await Bun.sleep(20); }
    }
    const removalId = crypto.randomUUID();
    let finished = false;
    const removal = docker("exec", instance.name, "bun", "packages/moderation/src/relayPurgeCli.ts", removalId, racing.policy.communityId, racing.channelId, racing.allowedRumorId).then((value) => { finished = true; return value; });
    removal.catch(() => {});
    while (!(await sql`SELECT 1 FROM moderation.tombstones WHERE community_id = ${racing.policy.communityId}`).length) {
      if (Date.now() > deadline) throw new Error("Tombstone not installed");
      await Bun.sleep(20);
    }
    // Probe the very lock the writer must already hold, independent of scheduling the purge process.
    let lockWasHeld = false;
    try { await docker("exec", instance.name, "flock", "--nonblock", "/data/admission.lock", "true"); }
    catch { lockWasHeld = true; }
    assert.equal(lockWasHeld, true, "Writer must retain the purge barrier between admission and commit");
    assert.equal(finished, false, "Removal cannot be verified before an admitted writer commits");
    await docker("exec", instance.name, "touch", "/data/release");
    assert.equal(await publishing, true);
    assert.equal(JSON.parse(await removal).state, "verified");
    assert.equal((await racer.query([racing.allowed.id])).length, 0);
    console.log("PASS concurrent purge: admitted writer drains before removal, fresh raw query is empty");
    console.log(`PASS tested image ${process.env.STRFRY_TEST_IMAGE}`);
  } else {
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
  }
} finally {
  for (const ws of sockets) ws.close();
  if (sql) await sql.end();
  for (const name of containers.reverse()) await docker("rm", "-f", name).catch(() => {});
  await docker("network", "rm", label).catch(() => {});
  if (snapshotImage) await docker("rmi", snapshotImage).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
