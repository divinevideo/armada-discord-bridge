/** Disposable, synthetic-only external-hook measurements. Importing never starts Docker. */
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import postgres from "postgres";
import { schnorr } from "@noble/curves/secp256k1.js";
import { encrypt } from "nostr-tools/nip44";
import { getEventHash, getPublicKey, verifyEvent } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";
import { baseRekeyGroupKey, buildChannelEdition, buildMetadataEdition, buildRekeyRumors, buildRumor, bytesToHex, channelBindingTags, channelGroupKey, communityIdOf, controlSignerGroupKey, currentControlGroup, currentControlWriteGroup, editionHash, epochKeyCommitment, hex32, openWrap, parseEdition, KIND_SEAL_ENCRYPTED, KIND_SEAL_PLAINTEXT } from "@armada-bridge/concord-core";
import type { CommunityV2, GroupKey, Rumor } from "@armada-bridge/concord-core";
import type { CommunityPolicy, StreamDescriptor } from "../../packages/moderation/src/contracts";
import { controlState } from "../../packages/moderation/src/relayPolicy";
import { PolicyStore, migrateModeration } from "../../packages/moderation/src/policyStore";
import { REQUIRED_CAPACITY_CASES, capacityReportHash } from "../../packages/moderation/src/capacityContract";
import type { CapacityCaseId, CapacityMeasurementReport, CapacitySample } from "../../packages/moderation/src/capacityContract";

const hash = (data: string) => createHash("sha256").update(data).digest("hex");
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical((value as any)[key])).join(",")}}`; return JSON.stringify(value); }
const seed = (label: string) => new Uint8Array(createHash("sha256").update("synthetic-capacity-v1:" + label).digest());
function signed(template: EventTemplate, key: Uint8Array): NostrEvent {
  const event = { ...template, pubkey: getPublicKey(key) }, id = getEventHash(event);
  return { ...event, id, sig: bytesToHex(schnorr.sign(hex32(id), key, seed("aux:" + id))) };
}
function sealed(rumor: Rumor, group: GroupKey, key: Uint8Array, plaintext = false): NostrEvent {
  const kind = plaintext ? KIND_SEAL_PLAINTEXT : KIND_SEAL_ENCRYPTED;
  const seal = signed({ kind, created_at: rumor.created_at, tags: [], content: plaintext ? JSON.stringify(rumor) : encrypt(JSON.stringify(rumor), group.convKey, seed("seal:" + rumor.id)) }, key);
  return signed({ kind: 1059, created_at: rumor.created_at, tags: [["p", getPublicKey(seed("ephemeral:" + seal.id))]], content: encrypt(JSON.stringify(seal), group.convKey, seed("wrap:" + seal.id)) }, group.sk);
}
export interface CapacityMatrix {
  version: 1; historyPoints: number[]; repetitions: number; concurrency: number; cpu: number; memoryBytes: number;
  databaseCpu: number; databaseMemoryBytes: number; lateObservationMs: number; observationTimeoutMs: number;
  cases: CapacityCaseId[]; cacheEntryWorkingSet: number; cacheByteWorkingSet: number; heldRoots: number; channels: number;
}
export function validateMatrix(value: unknown): CapacityMatrix {
  const m = value as CapacityMatrix;
  if (!m || m.version !== 1 || !Array.isArray(m.historyPoints) || !m.historyPoints.length || m.historyPoints.some((n, i) => !Number.isSafeInteger(n) || n < 0 || n > 4095 || (i > 0 && n <= m.historyPoints[i - 1]))) throw new Error("Invalid capacity history search matrix");
  for (const key of ["repetitions", "concurrency", "memoryBytes", "databaseMemoryBytes", "lateObservationMs", "observationTimeoutMs", "cacheEntryWorkingSet", "cacheByteWorkingSet", "heldRoots", "channels"] as const) if (!Number.isSafeInteger(m[key]) || m[key] <= 0) throw new Error("Invalid matrix resource/count: " + key);
  if (![m.cpu, m.databaseCpu].every((n) => Number.isFinite(n) && n > 0) || m.observationTimeoutMs <= 3000 || m.lateObservationMs < 3000 || m.heldRoots > 128 || m.channels > 128 || !Array.isArray(m.cases) || m.cases.length !== REQUIRED_CAPACITY_CASES.length || REQUIRED_CAPACITY_CASES.some((id) => m.cases.filter((c) => c === id).length !== 1)) throw new Error("Incomplete matrix or observer shorter than external/late-work horizon");
  return m;
}

/** Every counted history item is a distinct valid owner edition in a contiguous chain. */
export function capacityFixture(historyCount: number, options: { label?: string; roots?: number; channels?: number; large?: boolean } = {}) {
  if (!Number.isSafeInteger(historyCount) || historyCount < 0 || historyCount > 4095) throw new Error("Invalid history count");
  const label = options.label ?? "fixture", ownerKey = seed(label + ":owner"), memberKey = seed(label + ":member");
  const owner = getPublicKey(ownerKey), member = getPublicKey(memberKey), ownerSalt = seed(label + ":salt"), id = communityIdOf(hex32(owner), ownerSalt);
  const rootCount = options.roots ?? 1;
  const roots = Array.from({ length: rootCount }, (_, n) => {
    const epoch = BigInt(rootCount - n - 1), key = seed(`${label}:root:${epoch}`), controlRoot = seed(`${label}:control:${epoch}`);
    return { epoch, key, controlRoot, controlPk: controlSignerGroupKey(controlRoot, id, epoch).pk };
  });
  const community: CommunityV2 = { id, idHex: bytesToHex(id), owner, ownerSalt, root: roots[0].key, rootEpoch: roots[0].epoch, controlRoot: roots[0].controlRoot, controlPk: roots[0].controlPk, heldRoots: roots.map(({ controlRoot: _secret, ...rest }) => rest), privateChannels: [], relays: ["wss://relay.example"], name: "Synthetic capacity fixture" };
  const channelCount = Math.min(options.channels ?? 1, Math.max(1, historyCount));
  const channels = Array.from({ length: channelCount }, (_, n) => seed(`${label}:channel:${n}`));
  const controlGroups = roots.map((root) => currentControlWriteGroup({ ...community, root: root.key, rootEpoch: root.epoch, controlPk: root.controlPk, controlRoot: root.controlRoot }));
  const describe = (plane: StreamDescriptor["plane"], group: GroupKey, epoch: bigint, channelId?: string): StreamDescriptor => ({ communityId: community.idHex, plane, epoch: epoch.toString(), channelId, key: { pk: group.pk, convKey: group.convKey, restricted: plane === "control" || undefined } });
  const controlStreams = controlGroups.map((group, n) => describe("control", group, roots[n].epoch));
  const streams: StreamDescriptor[] = [...controlStreams];
  for (const channel of channels) for (const root of roots) streams.push(describe("chat", channelGroupKey(root.key, channel, root.epoch), root.epoch, bytesToHex(channel)));
  const rekeyGroup = baseRekeyGroupKey(community.root, community.id, community.rootEpoch + 1n);
  streams.push({ ...describe("rekey", rekeyGroup, community.rootEpoch + 1n), previousEpoch: community.rootEpoch.toString(), previousCommit: bytesToHex(epochKeyCommitment(community.rootEpoch, community.root)) });
  const heads = new Map<string, { version: bigint; hash: Uint8Array }>();
  const makeEdition = (index: number) => {
    const metadata = options.large && index >= channelCount;
    const entity = metadata ? community.id : channels[index < channelCount ? index : 0];
    const previous = heads.get(bytesToHex(entity)), version = (previous?.version ?? 0n) + 1n;
    const common = { actorPubkey: owner, version, prevHash: previous?.hash, createdAtSecs: 1700000000 + index };
    const rumor = metadata ? buildMetadataEdition(id, { name: "Synthetic capacity fixture", description: "x".repeat(10000), relays: ["wss://relay.example"] }, common) : buildChannelEdition(entity, { name: "synthetic-" + index, private: false }, common);
    heads.set(bytesToHex(entity), { version, hash: editionHash(entity, version, previous?.hash, new TextEncoder().encode(rumor.content)) });
    const group = controlGroups[index % rootCount];
    return sealed(rumor, group, ownerKey, true);
  };
  const controlEvents = Array.from({ length: historyCount }, (_, n) => makeEdition(n));
  const policy: CommunityPolicy = { communityId: community.idHex, owner, ownerSalt: bytesToHex(ownerSalt), rootEpoch: community.rootEpoch.toString(), revision: 1, complete: true, validUntil: Date.now() + 120000, controlStreams, controlEvents, banned: [], publicAuthors: [owner, member], snapshotAuthorities: [owner] };
  if (historyCount === 0) streams.splice(controlStreams.length, channels.length * rootCount);
  const folded = controlState(policy).folded;
  if (folded.incomplete.length || new Set(controlEvents.map((e) => e.id)).size !== historyCount || controlEvents.some((e) => !verifyEvent(e))) throw new Error("Capacity fixture failed contiguous valid history validation");
  const channelId = bytesToHex(channels[0]), chat = channelGroupKey(community.root, channels[0], community.rootEpoch);
  const message = (sequence: number) => sealed(buildRumor({ pubkey: member, kind: 9, content: "Synthetic capacity message " + sequence, tags: channelBindingTags(channelId, community.rootEpoch), ms: 1701000000000 + sequence }), chat, memberKey);
  const rekey = (sequence = 0) => sealed(buildRekeyRumors(owner, { scope: { kind: "root" }, newEpoch: community.rootEpoch + 1n, prevEpoch: community.rootEpoch, prevCommit: bytesToHex(epochKeyCommitment(community.rootEpoch, community.root)) }, [], 1701000000000 + sequence)[0], rekeyGroup, ownerKey);
  return { policy, streams, message, rekey, append: () => makeEdition(historyCount), historyBytes: Buffer.byteLength(JSON.stringify(controlEvents)), fixtureHash: hash(JSON.stringify(controlEvents)), verifyChain: () => controlState(policy).folded.incomplete.length === 0 };
}

async function command(args: string[]): Promise<string> {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${args[0]} ${args[1]} failed: ${err}`);
  return (args[0] === "docker" && args[1] === "logs" ? out + "\n" + err : out).trim();
}
async function until<T>(check: () => T | undefined, timeout: number): Promise<T> {
  const started = performance.now();
  while (true) {
    const result = check(); if (result !== undefined) return result;
    if (performance.now() - started >= timeout) throw new Error("Capacity observer deadline exceeded");
    await Bun.sleep(5);
  }
}
async function socket(url: string) {
  const ws = new WebSocket(url), messages: any[][] = [];
  ws.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data))));
  await new Promise<void>((resolve, reject) => { ws.addEventListener("open", () => resolve()); ws.addEventListener("error", () => reject(new Error("Capacity relay socket failed"))); });
  return { ws, messages, query: async (id: string) => {
    const sub = crypto.randomUUID(), from = messages.length;
    ws.send(JSON.stringify(["REQ", sub, { ids: [id] }]));
    await until(() => messages.slice(from).some((m) => m[0] === "EOSE" && m[1] === sub) ? true : undefined, 5000);
    ws.send(JSON.stringify(["CLOSE", sub]));
    return messages.slice(from).some((m) => m[0] === "EVENT" && m[1] === sub && m[2]?.id === id);
  } };
}

/** Mounted only into disposable fixtures; never a production config path. */
export function capacityCalibrationLauncher(configPath = "/capacity/calibration.json"): string {
  return `import { readFileSync } from 'node:fs';\nimport postgres from '/opt/divine/node_modules/postgres/src/index.js';\nimport { runPlugin } from '/opt/divine/packages/moderation/src/strfryPlugin.ts';\nimport { PolicyStore } from '/opt/divine/packages/moderation/src/policyStore.ts';\nconst sql=postgres(process.env.MODERATION_DATABASE_URL,{max:1,onnotice:()=>{}});\nconsole.error(JSON.stringify({type:'capacity_calibration_launcher',pid:process.pid,synthetic:true}));\ntry{await runPlugin(process.stdin,line=>new Promise((resolve,reject)=>process.stdout.write(line,e=>e?reject(e):resolve())),(event,signal)=>{const data=JSON.parse(readFileSync(${JSON.stringify(configPath)},'utf8'));const store=new PolicyStore(sql,{capacity:{communities:new Map(data.communities),contract:data.contract},onAdmissionTiming:timing=>console.error(JSON.stringify({type:'moderation_admission_timing',eventId:event.id,...timing}))});return store.admit(event,signal);});}finally{await sql.end({timeout:1});}\n`;
}

export function expectedCapacityAcceptance(id: CapacityCaseId, historyCount: number): boolean {
  return !["plugin_failure", "external_timeout", "sql_timeout"].includes(id) && (historyCount > 0 || id === "append" || id === "rekey");
}

export function serializeCapacityReport(report: CapacityMeasurementReport): { json: string; hash: string } {
  const json = JSON.stringify(report, null, 2) + "\n";
  // External contracts contain JSON: hash the same values the consumer reads.
  return { json, hash: capacityReportHash(JSON.parse(json)) };
}

export function summarizeCapacity(report: CapacityMeasurementReport, urgentReserve?: number) {
  const distribution = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? { count: sorted.length, p50: sorted[Math.floor((sorted.length - 1) * 0.5)], p95: sorted[Math.ceil((sorted.length - 1) * 0.95)], max: sorted.at(-1)! } : null; };
  const ordinary = report.cases.filter(entry => !["plugin_failure", "sql_timeout", "external_timeout"].includes(entry.id));
  const pass = (sample: CapacitySample) => sample.expectedAccept && sample.accepted && sample.okReceived && !sample.unsafeEffect && !sample.lateDatabaseWrite && sample.wallMs < 3000 && sample.innerAdmissionMs !== null && sample.innerAdmissionMs < 1500;
  const passing = ordinary.flatMap(entry => entry.samples.filter(pass));
  const failures = ordinary.flatMap(entry => entry.samples.filter(sample => sample.expectedAccept && !pass(sample)));
  const earliestFailure = failures.length ? Math.min(...failures.map(sample => sample.historyCount)) : null;
  const comparisonBound = earliestFailure ?? 4096;
  const measuredInFlight = Math.max(0, ...passing.map(sample => sample.inFlight));
  const allMeasured = report.cases.every(entry => entry.status === "measured") && ordinary.every(entry => entry.samples.some(pass));
  const testedCeiling = allMeasured ? Math.min(...ordinary.map(entry => Math.max(...entry.samples.filter(pass).map(sample => sample.historyCount)))) : 0;
  const pause = urgentReserve !== undefined && Number.isSafeInteger(urgentReserve) && urgentReserve > 0 && allMeasured ? Math.min(testedCeiling, comparisonBound - 1, 4095) - urgentReserve - measuredInFlight : null;
  return { certified: false, earliestFailureHistoryCount: earliestFailure, measuredInFlight, testedCeiling,
    candidatePauseHistoryCount: pause !== null && pause > 0 ? pause : null,
    candidateReason: pause !== null && pause > 0 ? "Review candidate only; destination/controller/intervention/rekey assumptions and final entrypoint replay remain required." : "No complete measured envelope/reserve; no supported ceiling inferred.",
    cases: report.cases.map(entry => ({ id: entry.id, status: entry.status, reason: entry.reason, samples: entry.samples.length,
      externalWallMs: distribution(entry.samples.map(sample => sample.wallMs)), innerAdmissionMs: distribution(entry.samples.flatMap(sample => sample.innerAdmissionMs === null ? [] : [sample.innerAdmissionMs])),
      unsafeOutcomes: entry.samples.filter(sample => sample.unsafeEffect || sample.lateDatabaseWrite || !sample.okReceived).length })) };
}

export async function measureCapacity(matrix: CapacityMatrix): Promise<CapacityMeasurementReport> {
  validateMatrix(matrix);
  const image = process.env.STRFRY_TEST_IMAGE;
  if (!image) throw new Error("STRFRY_TEST_IMAGE must name a locally built exact candidate");
  const imageInfo = JSON.parse(await command(["docker", "image", "inspect", image]))[0];
  const sourceSha = imageInfo.Config.Labels?.["org.opencontainers.image.revision"], harnessSha = await command(["git", "rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40}$/.test(sourceSha ?? "") || !/^[0-9a-f]{40}$/.test(harnessSha) || !/^sha256:[0-9a-f]{64}$/.test(imageInfo.Id)) throw new Error("Immutable image/source/harness identity required");
  if (await command(["git", "status", "--porcelain", "--untracked-files=no"])) throw new Error("Commit the capacity harness before measuring");
  const label = `capacity-${process.pid}-${crypto.randomUUID()}`, directory = await mkdtemp(join(tmpdir(), label));
  await chmod(directory, 0o755);
  const output = resolve(process.env.CAPACITY_OUTPUT_DIR ?? join(directory, "report"));
  await mkdir(output, { recursive: true });
  const platform = `${imageInfo.Os}/${imageInfo.Architecture}`, host = await command(["docker", "info", "--format", "{{.Architecture}}"]);
  const native = ({ x86_64: "amd64", aarch64: "arm64" } as Record<string, string>)[host] ?? host;
  const pgImage = "postgres:16@sha256:a3b7f434b2dc57ce85a67e171163eb8ab1a1ebcb39d27484661f26b1dfbe30d6";
  const report: CapacityMeasurementReport = { version: 1, sourceSha, harnessSha, imageId: imageInfo.Id, platform, resourceEnvelope: { cpus: matrix.cpu, memoryBytes: matrix.memoryBytes, database: `${pgImage};cpus=${matrix.databaseCpu};memoryBytes=${matrix.databaseMemoryBytes}` }, fixtureHash: hash("synthetic-capacity-v1"), matrixHash: hash(JSON.stringify(matrix)), startedAt: Date.now(), finishedAt: 0, emulated: native !== imageInfo.Architecture, certified: false, provenance: { destinationMatched: false, controllerModelVerified: false }, cases: REQUIRED_CAPACITY_CASES.map((id) => ({ id, status: "unsupported", reason: "not run", samples: [] })) };
  const containers: string[] = [], sockets: WebSocket[] = [], fixtureHashes: string[] = [];
  let sql: postgres.Sql | undefined, locker: postgres.Sql | undefined;
  const communities: [string, string][] = [];
  const calibration = process.env.CAPACITY_MODE !== "entrypoint";
  const synthetic = { version: 1, sourceSha, harnessSha, imageId: imageInfo.Id, platform, reportHash: "0".repeat(64), resourceEnvelope: report.resourceEnvelope, maxima: { historyCount: 4096, historyBytes: Number.MAX_SAFE_INTEGER, rekeyCount: 4096, streamCount: 1024, inFlight: matrix.concurrency, innerAdmissionMs: 1499 }, thresholds: { warningHistoryCount: 4095, pauseHistoryCount: 4096, urgentReserve: 0 }, deadlines: { sqlMs: 1500, pluginMs: 2000, externalMs: 3000, observedMaxMs: 2999 }, maxSampleAgeMs: 120000, measuredAt: Date.now() };
  const launcher = capacityCalibrationLauncher();
  const docker = (...args: string[]) => command(["docker", ...args]);
  await writeFile(join(directory, "launcher.ts"), launcher);
  await writeFile(join(directory, "plugin.sh"), "#!/bin/sh\nexec bun /capacity/launcher.ts\n", { mode: 0o755 });
  try {
    await docker("network", "create", label);
    const dbName = label + "-pg";
    containers.push(dbName);
    await docker("run", "-d", "--name", dbName, "--network", label, "--network-alias", "pg", "--cpus", String(matrix.databaseCpu), "--memory", String(matrix.databaseMemoryBytes), "-p", "127.0.0.1::5432", "-e", "POSTGRES_USER=bridge", "-e", "POSTGRES_DB=bridge", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", pgImage);
    const pgLimits = JSON.parse(await docker("inspect", dbName, "--format", "{{json .HostConfig}}"));
    const pgId = await docker("inspect", dbName, "--format", "{{.Image}}");
    const pgPlatform = await docker("image", "inspect", pgId, "--format", "{{.Os}}/{{.Architecture}}");
    report.resourceEnvelope.database += `;localImageId=${pgId};platform=${pgPlatform}`;
    if (pgLimits.Memory !== matrix.databaseMemoryBytes || pgLimits.NanoCpus !== matrix.databaseCpu * 1e9) throw new Error("PostgreSQL resource limits differ from matrix");
    for (let attempt = 0; ; attempt++) {
      try { await docker("exec", dbName, "pg_isready", "-h", "127.0.0.1", "-U", "bridge"); break; }
      catch { if (attempt > 200) throw new Error("Capacity PostgreSQL unavailable"); await Bun.sleep(100); }
    }
    const pgPort = (await docker("port", dbName, "5432/tcp")).split(":").at(-1), url = `postgres://bridge@127.0.0.1:${pgPort}/bridge`;
    sql = postgres(url, { max: Math.max(2, matrix.concurrency), onnotice: () => {} }); locker = postgres(url, { max: 1, onnotice: () => {} });
    await migrateModeration(sql);
    const store = new PolicyStore(sql);
    async function ready(port: string | undefined) {
      for (let attempt = 0; ; attempt++) { try { await fetch(`http://127.0.0.1:${port}`); return; } catch { if (attempt > 200) throw new Error("Capacity relay unavailable"); await Bun.sleep(50); } }
    }
    async function start(mode: string) {
      const name = `${label}-${mode}-${containers.length}`;
      const plugin = mode === "plugin_failure" || mode === "external_timeout" ? `/capacity/${mode}.sh` : calibration ? "/capacity/plugin.sh" : "/usr/local/bin/relay-policy";
      if (mode === "plugin_failure" || mode === "external_timeout") await writeFile(join(directory, mode + ".sh"), "#!/bin/sh\n" + (mode === "plugin_failure" ? "exit 1\n" : "sleep 10\n"), { mode: 0o755 });
      const config = join(directory, name + ".conf");
      await writeFile(config, `db = "/data/db/"\nrelay { nofiles = 0 bind = "0.0.0.0" port = 7777 writePolicy { plugin = "${plugin}" timeoutSeconds = 3 } logging { dumpInAll = false dumpInEvents = false dumpInReqs = false invalidEvents = false } }\n`);
      const args = ["run", "-d", "--name", name, "--network", label, "--cpus", String(matrix.cpu), "--memory", String(matrix.memoryBytes), "--ulimit", "nofile=65536:65536", "-p", "127.0.0.1::7777", "-v", `${config}:/data/strfry.conf:ro`, "-v", `${directory}:/capacity:ro`, "-e", "MODERATION_DATABASE_URL=postgres://bridge@pg/bridge", "-e", "MODERATION_CAPACITY_TIMING=1", "-e", `MODERATION_SOURCE_SHA=${sourceSha}`, "-e", `MODERATION_CAPACITY_PLATFORM=${platform}`, "-e", `MODERATION_COMMUNITY_ORGS=${JSON.stringify(Object.fromEntries(communities))}`];
      if (!calibration) {
        if (!process.env.CAPACITY_CONTRACT_FILE) throw new Error("Entrypoint measurement requires an explicitly reviewed external contract");
        args.push("-v", `${resolve(process.env.CAPACITY_CONTRACT_FILE)}:/capacity-contract.json:ro`, "-e", "MODERATION_CAPACITY_CONTRACT_FILE=/capacity-contract.json");
      }
      args.push(imageInfo.Id); containers.push(name); await docker(...args);
      const limits = JSON.parse(await docker("inspect", name, "--format", "{{json .HostConfig}}"));
      if (limits.Memory !== matrix.memoryBytes || limits.NanoCpus !== matrix.cpu * 1e9) throw new Error("Relay resource limits differ from matrix");
      const port = (await docker("port", name, "7777/tcp")).split(":").at(-1), relayUrl = `ws://127.0.0.1:${port}`;
      await ready(port);
      const publisher = await socket(relayUrl), subscriber = await socket(relayUrl); sockets.push(publisher.ws, subscriber.ws);
      const subscription = crypto.randomUUID(); subscriber.ws.send(JSON.stringify(["REQ", subscription, { kinds: [1059] }]));
      await until(() => subscriber.messages.some((m) => m[0] === "EOSE" && m[1] === subscription) ? true : undefined, 5000);
      return { name, publisher, subscriber };
    }
    let sequence = 0;
    async function effect(id: string) { return Number((await sql!`SELECT count(*) AS count FROM (SELECT event_id FROM moderation.carriers WHERE event_id=${id} UNION ALL SELECT event_id FROM moderation.accepted_control WHERE event_id=${id} UNION ALL SELECT event_id FROM moderation.rekey_events WHERE event_id=${id}) q`)[0].count) > 0; }
    async function sample(instance: Awaited<ReturnType<typeof start>>, f: ReturnType<typeof capacityFixture>, id: CapacityCaseId, expectedAccept: boolean, event: NostrEvent, inFlight = 1): Promise<CapacitySample> {
      await sql!`UPDATE moderation.community_policy SET payload=jsonb_set(payload,'{validUntil}',${sql!.json(Date.now()+120000)}) WHERE community_id=${f.policy.communityId}`;
      const measuredPolicy = await store.getPolicy(f.policy.communityId);
      const measuredRekeys = await sql!`SELECT event FROM moderation.rekey_events WHERE community_id=${f.policy.communityId}`;
      const hasCapacity = await sql!`SELECT to_regclass('moderation.public_capacity_state') AS name`;
      if (hasCapacity[0].name) await sql!`UPDATE moderation.public_capacity_state SET observed_at=clock_timestamp() WHERE org_id='synthetic-capacity' AND community_id=${f.policy.communityId}`;
      const before = await effect(event.id), messagesFrom = instance.publisher.messages.length;
      const logsBefore = (await docker("logs", instance.name)).split("\n").filter((line) => line.includes('"type":"moderation_admission_timing"')).length;
      const started = performance.now(); instance.publisher.ws.send(JSON.stringify(["EVENT", event]));
      let ok: any[] | undefined, error: string | undefined;
      try { ok = await until(() => instance.publisher.messages.slice(messagesFrom).find((m) => m[0] === "OK" && m[1] === event.id), matrix.observationTimeoutMs); } catch { error = "matching OK not observed within observer horizon"; }
      const wallMs = performance.now() - started, accepted = ok?.[2] === true;
      const dbAtAck = await effect(event.id), persisted = await instance.publisher.query(event.id);
      let fanout = instance.subscriber.messages.some((m) => m[0] === "EVENT" && m[2]?.id === event.id);
      // A post-ack observation horizon exceeds the unchanged external hook deadline.
      await Bun.sleep(matrix.lateObservationMs);
      fanout = instance.subscriber.messages.some((m) => m[0] === "EVENT" && m[2]?.id === event.id);
      const dbAfter = await effect(event.id), persistedAfter = await instance.publisher.query(event.id);
      const timings = (await docker("logs", instance.name)).split("\n").filter((line) => line.includes('"type":"moderation_admission_timing"')).slice(logsBefore).flatMap((line) => { try { return [JSON.parse(line.slice(line.indexOf("{")))]; } catch { return []; } });
      const correlated = timings.filter((timing) => timing.eventId === event.id);
      const timing = correlated.length === 1 ? correlated[0].innerAdmissionMs : inFlight === 1 && timings.length === 1 ? timings[0].innerAdmissionMs : null;
      return { caseId: id, historyCount: measuredPolicy!.controlEvents.length + measuredRekeys.length, historyBytes: Buffer.byteLength(JSON.stringify(measuredPolicy!.controlEvents)) + Buffer.byteLength(JSON.stringify(measuredRekeys.map(row => row.event))), rekeyCount: measuredRekeys.length, streamCount: f.streams.length, inFlight, wallMs, innerAdmissionMs: Number.isFinite(timing) ? timing : null, expectedAccept, accepted, okReceived: !!ok, persisted, fanout, lateDatabaseWrite: !before && !dbAtAck && dbAfter, unsafeEffect: (!accepted && (dbAfter || persistedAfter || fanout)) || (accepted && (!dbAfter || !persistedAfter)), ...(["plugin_failure", "external_timeout"].includes(id) ? { innerNotStarted: true } : {}), ...(error ? { error } : {}) };
    }
    for (const entry of report.cases) {
      try {
        // Reuse one hook process across pressure/warm points; cold/restart explicitly restart it.
        let instance: Awaited<ReturnType<typeof start>> | undefined;
        let previousPass: number | undefined, bracketFailure: number | undefined;
        const pressure = new Map<string, { count: number; bytes: number }>();
        const points = [...matrix.historyPoints];
        for (let pointIndex = 0; pointIndex < points.length; pointIndex++) {
          const count = points[pointIndex];
          const f = capacityFixture(count, { label: `${entry.id}:${count}`, roots: entry.id === "held_roots" || entry.id === "rekey" ? matrix.heldRoots : 1, channels: entry.id === "stream_growth" ? matrix.channels : 1, large: entry.id === "cache_bytes" });
          fixtureHashes.push(f.fixtureHash); communities.push([f.policy.communityId, "synthetic-capacity"]);
          await writeFile(join(directory, "calibration.json"), JSON.stringify({ contract: synthetic, communities }));
          await store.install(f.policy, f.streams, 0);
          if (calibration) {
            // Only the disposable operator seeds its own fixture latch; the deployed entrypoint has no bypass.
            const table = await sql`SELECT to_regclass('moderation.public_capacity_state') AS name`;
            if (table[0].name) await sql`INSERT INTO moderation.public_capacity_state(org_id,community_id,state,contract_hash,reason_code,history_count,history_bytes,rekey_count,stream_count,in_flight,observed_at) VALUES('synthetic-capacity',${f.policy.communityId},'normal',${hash(canonical(synthetic))},'synthetic_calibration',${count},${f.historyBytes},0,${f.streams.length},0,clock_timestamp()) ON CONFLICT DO NOTHING`;
          }
          if (!instance || entry.id === "cold" || entry.id === "restart" || !calibration) {
            if (instance) { instance.publisher.ws.close(); instance.subscriber.ws.close(); await docker("rm", "-f", instance.name); }
            instance = await start(entry.id);
          }
          let beforeRestart: NostrEvent | undefined;
          if (entry.id === "warm" || entry.id === "restart") { beforeRestart = f.message(sequence++); const warm = await sample(instance, f, entry.id, count > 0, beforeRestart); entry.samples.push(warm); }
          if (entry.id === "restart") { instance.publisher.ws.close(); instance.subscriber.ws.close(); await docker("restart", instance.name); const port = (await docker("port", instance.name, "7777/tcp")).split(":").at(-1); await ready(port); const publisher = await socket(`ws://127.0.0.1:${port}`), subscriber = await socket(`ws://127.0.0.1:${port}`); sockets.push(publisher.ws, subscriber.ws); subscriber.ws.send(JSON.stringify(["REQ", "after-restart", { kinds: [1059] }])); await until(() => subscriber.messages.some((m) => m[0] === "EOSE") ? true : undefined, 5000); instance = { name: instance.name, publisher, subscriber }; if (count > 0 && beforeRestart && !await publisher.query(beforeRestart.id)) throw new Error("Accepted carrier lost across actual relay restart"); }
          for (let rep = 0; rep < matrix.repetitions; rep++) {
            if (entry.id === "cold" && rep > 0) { instance.publisher.ws.close(); instance.subscriber.ws.close(); await docker("rm", "-f", instance.name); instance = await start(entry.id); }
            const event = entry.id === "append" ? f.append() : entry.id === "rekey" ? f.rekey(sequence++) : f.message(sequence++);
            const expected = expectedCapacityAcceptance(entry.id, count);
            let release: Promise<unknown> | undefined;
            if (entry.id === "lock_contention" || entry.id === "sql_timeout") {
              await locker`SELECT pg_advisory_lock(hashtextextended(${f.policy.communityId},483210))`;
              release = Bun.sleep(entry.id === "sql_timeout" ? 2000 : 250).then(() => locker!`SELECT pg_advisory_unlock(hashtextextended(${f.policy.communityId},483210))`);
            }
            try {
              if (entry.id === "concurrency") {
                entry.samples.push(...await Promise.all(Array.from({ length: matrix.concurrency }, () => sample(instance!, f, entry.id, expected, f.message(sequence++), matrix.concurrency))));
              } else entry.samples.push(await sample(instance, f, entry.id, expected, event));
            } finally { await release; }
            const recent = entry.samples.at(-1)!;
            if (expected && (!recent.accepted || recent.wallMs >= 3000)) {
              bracketFailure = count;
              if (previousPass !== undefined && count - previousPass > 1) { const middle = Math.floor((count + previousPass) / 2); if (!points.includes(middle)) points.splice(pointIndex + 1, 0, middle); }
              break;
            }
            if (expected && recent.accepted) { previousPass = count; pressure.set(f.fixtureHash, { count, bytes: f.historyBytes }); if (bracketFailure !== undefined && bracketFailure - count > 1) { const middle = Math.floor((bracketFailure + count) / 2); if (!points.includes(middle)) points.splice(pointIndex + 1, 0, middle); } }
          }
          if (bracketFailure !== undefined && previousPass !== undefined && bracketFailure - previousPass <= 1) break;
        }
        const generatedCount = [...pressure.values()].reduce((n, point) => n + point.count, 0), generatedBytes = [...pressure.values()].reduce((n, point) => n + point.bytes, 0);
        const limits = entry.id === "cache_entries" && generatedCount <= matrix.cacheEntryWorkingSet ? "cache entry pressure not reached" : entry.id === "cache_bytes" && generatedBytes <= matrix.cacheByteWorkingSet ? "cache byte pressure not reached" : entry.samples.some((s) => s.innerAdmissionMs === null && !s.innerNotStarted) ? "inner timing unavailable or concurrent attribution ambiguous" : undefined;
        entry.status = limits ? "unsupported" : "measured"; entry.reason = limits;
        if (instance) { await writeFile(join(output, entry.id + "-relay.log"), await docker("logs", instance.name)); }
      } catch (error) { entry.status = "unsupported"; entry.reason = error instanceof Error ? error.message : "measurement failed"; }
      await writeFile(join(output, "partial-report.json"), JSON.stringify(report, null, 2) + "\n");
    }
  } finally {
    report.fixtureHash = hash(fixtureHashes.join("\n")); report.finishedAt = Date.now();
    const artifact = serializeCapacityReport(report);
    await writeFile(join(output, "measurement-report.json"), artifact.json);
    await writeFile(join(output, "summary.json"), JSON.stringify(summarizeCapacity(report, process.env.CAPACITY_URGENT_RESERVE ? Number(process.env.CAPACITY_URGENT_RESERVE) : undefined), null, 2) + "\n");
    await writeFile(join(output, "report.sha256"), artifact.hash + "\n");
    await writeFile(join(output, "mode.json"), JSON.stringify({ mode: calibration ? "synthetic-library-calibration" : "actual-deployed-entrypoint", certified: false, note: "No deployment/controller/resource certification is inferred. Raw errors and unsupported cases are retained." }, null, 2) + "\n");
    for (const ws of sockets) ws.close(); await sql?.end({ timeout: 2 }); await locker?.end({ timeout: 2 });
    for (const name of containers.reverse()) await docker("rm", "-f", name).catch(() => {});
    await docker("network", "rm", label).catch(() => {});
    if (!output.startsWith(directory + "/")) await rm(directory, { recursive: true, force: true });
  }
  console.log(`Capacity raw report: ${output}; certified=false`);
  return report;
}

if (import.meta.main) {
  const matrix = validateMatrix(JSON.parse(await readFile(process.env.CAPACITY_MATRIX ?? "scripts/fixtures/capacity-matrix.json", "utf8")));
  const report = await measureCapacity(matrix);
  if (report.cases.some((entry) => entry.status !== "measured" || entry.samples.some((sample) => sample.unsafeEffect || sample.lateDatabaseWrite || !sample.okReceived))) process.exitCode = 1;
}
