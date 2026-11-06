import { describe, expect, test } from 'bun:test';
import { benchmarkDatabaseGuard, benchmarkNamespaceGuard, benchmarkPod, destinationConfig, destinationOutputGuard, verifyRelayReadback } from './capacity-kubernetes';

const image = 'registry.example/relay@sha256:' + 'a'.repeat(64);
const sha = 'b'.repeat(40);
const config = { context: 'explicit-production', namespace: 'concord-capacity-synthetic', image, sourceSha: sha, databaseCluster: { namespace: 'postgres-clusters', name: 'postgres' }, relayDeployment: { namespace: 'armada-chat', name: 'concord-relay', container: 'relay' }, relayRequests: { cpu: 0.25, memoryBytes: 268435456 }, relayStorage: { claimName: 'capacity-data', productionClaimName: 'concord-relay' }, databaseSecret: 'benchmark-database', databaseSecretKey: 'DATABASE_URL', databaseName: 'concord_capacity_synthetic', databaseRole: 'concord_capacity_synthetic', postgresVersion: '18.1', platform: 'linux/amd64' };
const matrix = { cpu: 2, memoryBytes: 1073741824, databaseCpu: 2, databaseMemoryBytes: 8589934592 };
const db = { database: config.databaseName, role: config.databaseRole, login: config.databaseRole, loginCanLogin: true, serverVersion: '18.1', superuser: false, createDatabase: false, createRole: false, replication: false, bypassRls: false, ownsDatabase: true, populatedTables: 0, schemaPresent: true, roleMemberships: 0 };

describe('isolated destination measurement', () => {
  test('requires an immutable image, explicit context and isolated namespace/database', () => {
    expect(destinationConfig(config)).toEqual(config);
    for (const change of [{ context: '' }, { namespace: 'armada-chat' }, { image: 'registry.example/relay:latest' }, { databaseName: 'bridge' }, { databaseRole: 'concord_operator' }, { sourceSha: 'short' }, { platform: 'linux/arm64' }]) {
      expect(() => destinationConfig({ ...config, ...change })).toThrow();
    }
  });
  test('refuses populated, privileged, mismatched or wrong-version databases', () => {
    expect(() => benchmarkDatabaseGuard(config, db)).not.toThrow();
    for (const change of [{ loginCanLogin: false }, { database: 'bridge' }, { role: 'postgres' }, { serverVersion: '16.4' }, { populatedTables: 1 }, { schemaPresent: false }, { roleMemberships: 1 }, { superuser: true }, { createDatabase: true }, { createRole: true }, { replication: true }, { bypassRls: true }, { replication: undefined }, { bypassRls: undefined }, { ownsDatabase: false }]) {
      expect(() => benchmarkDatabaseGuard(config, JSON.parse(JSON.stringify({ ...db, ...change })))).toThrow();
    }
  });
  test('requires dedicated labeled namespace and deny-ingress policy before creating Pods', () => {
    const namespace = { metadata: { name: config.namespace, labels: { 'divine.video/capacity-benchmark': 'true' } } };
    const policy = { spec: { podSelector: {}, policyTypes: ['Ingress'], ingress: [] } };
    expect(() => benchmarkNamespaceGuard(config, namespace, [policy], [], [])).not.toThrow();
    expect(() => benchmarkNamespaceGuard(config, namespace, [], [], [])).toThrow();
    expect(() => benchmarkNamespaceGuard(config, namespace, [policy, { spec: { ingress: [{}] } }], [], [])).toThrow();
    expect(() => benchmarkNamespaceGuard(config, namespace, [policy], [{ kind: 'Pod' }], [])).toThrow();
    expect(() => benchmarkNamespaceGuard(config, namespace, [policy], [], [{ kind: 'Service' }])).toThrow();
    expect(() => benchmarkNamespaceGuard(config, { metadata: { name: config.namespace } }, [policy], [], [])).toThrow();
  });
  test('recognizes deny-ingress policies after Kubernetes omits the empty ingress list', () => {
    const namespace = { metadata: { name: config.namespace, labels: { 'divine.video/capacity-benchmark': 'true' } } };
    const storedPolicy = { spec: { podSelector: {}, policyTypes: ['Ingress', 'Egress'], egress: [{ ports: [{ port: 53, protocol: 'UDP' }] }] } };
    expect(() => benchmarkNamespaceGuard(config, namespace, [storedPolicy], [], [])).not.toThrow();
    for (const spec of [
      { ...storedPolicy.spec, policyTypes: ['Egress'] },
      { ...storedPolicy.spec, policyTypes: undefined },
      { ...storedPolicy.spec, podSelector: { matchLabels: { app: 'some-pods' } } },
      { ...storedPolicy.spec, ingress: [{}] },
    ]) expect(() => benchmarkNamespaceGuard(config, namespace, [{ spec }], [], [])).toThrow();
    expect(() => benchmarkNamespaceGuard(config, namespace, [storedPolicy, { spec: { ingress: [{}] } }], [], [])).toThrow();
  });
  test('only prepares a nonprivileged private Pod with a dedicated credential reference', () => {
    const pod = benchmarkPod(config, matrix, 'capacity-synthetic-1');
    expect(pod.kind).toBe('Pod');
    expect(() => benchmarkPod(config, matrix, 'capacity-' + 'a'.repeat(60))).toThrow();
    expect(pod.spec.hostNetwork).toBe(false);
    expect(pod.spec.automountServiceAccountToken).toBe(false);
    expect(pod.spec.nodeSelector).toEqual({ 'cloud.google.com/gke-provisioning': 'standard', 'kubernetes.io/arch': 'amd64' });
    const c = pod.spec.containers[0];
    expect(c.image).toBe(image);
    expect(pod.spec.volumes[0]).toEqual({ name: 'data', persistentVolumeClaim: { claimName: 'capacity-data' } });
    expect(c.volumeMounts[0]).toEqual({ name: 'data', mountPath: '/data', subPath: 'capacity-synthetic-1' });
    expect(c.resources.limits).toEqual({ cpu: '2', memory: '1073741824' });
    expect(c.securityContext.runAsNonRoot).toBe(true);
    expect(pod.spec.securityContext.fsGroupChangePolicy).toBe('OnRootMismatch');
    expect(c.env.find((e: any) => e.name === 'MODERATION_DATABASE_URL')).toEqual({ name: 'MODERATION_DATABASE_URL', valueFrom: { secretKeyRef: { name: 'benchmark-database', key: 'DATABASE_URL' } } });
    expect(JSON.stringify(pod)).not.toContain('postgres://');
    expect(JSON.stringify(pod)).not.toContain('LoadBalancer');
  });
  test('checks actual image/platform/source/resource identity instead of declaring destination certification', () => {
    const pod = benchmarkPod(config, matrix, 'capacity-synthetic-1');
    const running = { ...pod, status: { containerStatuses: [{ name: 'relay', imageID: image, restartCount: 0 }] } };
    const identity = { sourceSha: sha, platform: 'linux/amd64' };
    expect(() => verifyRelayReadback(config, matrix, running, identity, { metadata: { labels: { 'cloud.google.com/gke-provisioning': 'standard', 'kubernetes.io/arch': 'amd64' } } })).not.toThrow();
    expect(() => verifyRelayReadback(config, matrix, running, { ...identity, sourceSha: 'c'.repeat(40) }, { metadata: { labels: {} } })).toThrow();
    expect(() => verifyRelayReadback(config, matrix, { ...running, spec: { ...running.spec, containers: [{ ...running.spec.containers[0], resources: { limits: { cpu: '1', memory: '1073741824' } } }] } }, identity, {})).toThrow();
  });
});

import { KubernetesCapacity } from './capacity-kubernetes';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fullMatrix from './capacity-matrix.json';

test('Kubernetes lifecycle creates no exposure, verifies credentials before ready, and cleans only its UID', async () => {
  const calls: { args: string[]; input?: string }[] = [];
  const directory = await mkdtemp(join(tmpdir(), 'capacity-driver-test-'));
  let stopped = false, uid = 'synthetic-owned-uid', privilegedLogin = false;
  const m = { ...fullMatrix, ...matrix } as any;
  const pod = { ...benchmarkPod(config, m, 'capacity-synthetic-1'), metadata: { name: 'capacity-synthetic-1', uid }, status: { containerStatuses: [{ name: 'relay', imageID: image, restartCount: 0 }] } } as any;
  pod.spec.nodeName = 'synthetic-native-node';
  const execute = async (args: string[], input?: string) => {
    calls.push({ args, input });
    if (args.includes('create')) return JSON.stringify(pod);
    if (args.includes('get') && args.includes('pod')) return JSON.stringify({ ...pod, metadata: { ...pod.metadata, uid } });
    if (args.includes('get') && args.includes('node')) return JSON.stringify({ metadata: { labels: { 'cloud.google.com/gke-provisioning': 'standard', 'kubernetes.io/arch': 'amd64' } } });
    if (args.includes('exec') && args.includes('bun')) {
      return args.at(-1)!.includes('current_database') ? JSON.stringify({ ...db, ...(privilegedLogin ? { login: 'synthetic_admin', superuser: true } : {}), serverAddress: '10.0.0.2' }) : JSON.stringify({ sourceSha: sha, platform: 'linux/amd64' });
    }
    return '';
  };
  const backend = new KubernetesCapacity(config, m, execute, async args => {
    expect(args.at(-1)).toBe('pod/capacity-synthetic-1');
    return { url: 'ws://127.0.0.1:17777', stop: () => { stopped = true; } };
  });
  backend.evidence.databaseServerAddress = '10.0.0.2';
  try {
    await writeFile(join(directory, 'strfry.conf'), 'db = "/data/db/"');
    await writeFile(join(directory, 'calibration.json'), '{"synthetic":true}');
    expect(await backend.start('capacity-synthetic-1', join(directory, 'strfry.conf'), directory)).toBe('ws://127.0.0.1:17777');
    const create = calls.find(c => c.args.includes('create'))!;
    expect(JSON.parse(create.input!).kind).toBe('Pod');
    expect(calls.some(c => c.args.includes('apply'))).toBe(false);
    const dbCheck = calls.findIndex(c => c.args.at(-1)?.includes('current_database'));
    const ready = calls.findIndex(c => c.args.at(-1)?.includes('/capacity/ready.new'));
    expect(dbCheck).toBeGreaterThan(-1); expect(ready).toBeGreaterThan(dbCheck);
    uid = 'replacement-not-owned';
    await expect(backend.remove('capacity-synthetic-1')).rejects.toThrow('ownership');
    expect(calls.some(c => c.args.includes('delete'))).toBe(false);
    uid = 'synthetic-owned-uid';
    await backend.close();
    expect(stopped).toBe(true);
    const removal = calls.find(c => c.args.includes('delete'))!;
    expect(JSON.parse(removal.input!).preconditions).toEqual({ uid: 'synthetic-owned-uid' });
    expect(calls.some(c => c.args.includes('--for=delete') && c.args.includes('pod/capacity-synthetic-1'))).toBe(true);
    expect(backend.evidence.certified).toBe(false);
    expect(backend.evidence.destinationMatched).toBe(false);
    expect(backend.evidence.controllerModelVerified).toBe(false);
    expect(calls.every(c => c.args.includes('--context=explicit-production'))).toBe(true);
    const readyCount = calls.filter(c => c.args.at(-1)?.includes('/capacity/ready.new')).length;
    privilegedLogin = true;
    await expect(backend.start('capacity-synthetic-1', join(directory, 'strfry.conf'), directory)).rejects.toThrow('login');
    expect(calls.filter(c => c.args.at(-1)?.includes('/capacity/ready.new'))).toHaveLength(readyCount);
    await backend.close();

  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('refuses mismatched target deployment before any Kubernetes mutation', async () => {
  const calls: string[][] = [];
  const backend = new KubernetesCapacity(config, { ...fullMatrix, ...matrix } as any, async args => { calls.push(args); return JSON.stringify({ spec: { template: { spec: { containers: [{ name: 'relay', image: 'wrong' }] } } } }); });
  await expect(backend.prepare()).rejects.toThrow('deployment');
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain('get');
});

test('raw destination reports require a private output path outside the checkout', () => {
  expect(() => destinationOutputGuard(undefined, '/synthetic/checkout')).toThrow();
  expect(() => destinationOutputGuard('report', '/synthetic/checkout')).toThrow();
  expect(() => destinationOutputGuard('/synthetic/checkout/reports', '/synthetic/checkout')).toThrow();
  expect(() => destinationOutputGuard('/synthetic/private/reports', '/synthetic/checkout')).not.toThrow();
  expect(() => destinationOutputGuard('/synthetic/checkout-reports', '/synthetic/checkout')).not.toThrow();
  expect(() => destinationOutputGuard('/synthetic/checkout/..reports', '/synthetic/checkout')).toThrow('outside the checkout');
  // Ancestors hold the checkout itself; the parent and '/' are refused alike.
  for (const ancestor of ['/synthetic', '/', '/synthetic/checkout/..']) expect(() => destinationOutputGuard(ancestor, '/synthetic/checkout')).toThrow('ancestor');
});

test('destination preflight compares the selected relay, separate PVC and running CNPG primary', async () => {
  const m = { ...fullMatrix, ...matrix } as any;
  const relay = benchmarkPod(config, m, 'capacity-synthetic-1').spec.containers[0];
  const storage = { metadata: { labels: { 'divine.video/capacity-benchmark': 'true' } }, status: { phase: 'Bound' }, spec: { volumeName: 'synthetic-benchmark-pv', storageClassName: 'synthetic-rwo', volumeMode: 'Filesystem', accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '20Gi' } } } };
  let failStorage = false, primaryUID = 'synthetic-primary-uid', replacePrimaryDuringForward = false;
  const execute = async (args: string[]) => {
    expect(args).not.toContain('create'); expect(args).not.toContain('delete');
    if (args.includes('deployment')) return JSON.stringify({ spec: { template: { spec: { containers: [relay] } } } });
    if (args.includes('pvc')) return JSON.stringify(args.includes('capacity-data') ? storage : { ...storage, spec: { ...storage.spec, volumeName: failStorage ? 'synthetic-benchmark-pv' : 'synthetic-production-pv' } });
    if (args.includes('namespace')) return JSON.stringify({ metadata: { name: config.namespace, labels: { 'divine.video/capacity-benchmark': 'true' } } });
    if (args.includes('networkpolicies')) return JSON.stringify({ items: [{ spec: { podSelector: {}, policyTypes: ['Ingress'] } }] });
    if (args.includes('cluster')) return JSON.stringify({ spec: { imageName: 'registry.example/postgresql:18.1-test', resources: { limits: { cpu: '2', memory: '8Gi' } } }, status: { currentPrimary: 'synthetic-postgres-primary' } });
    if (args.includes('pod')) return JSON.stringify({ metadata: { uid: primaryUID }, spec: { containers: [{ name: 'postgres', image: 'registry.example/postgresql:18.1-test', resources: { limits: { cpu: '2', memory: '8Gi' } } }] }, status: { podIP: '10.0.0.2' } });
    return JSON.stringify({ items: [] });
  };
  let databaseForwardStopped = false;
  const makeBackend = () => new KubernetesCapacity(config, m, execute, async (args, port) => {
    expect(port).toBe(5432);
    expect(args).toContain('postgres-clusters');
    expect(args.at(-1)).toBe('pod/synthetic-postgres-primary');
    if (replacePrimaryDuringForward) primaryUID = 'replacement-primary-uid';
    return { url: 'ws://127.0.0.1:15432', stop: () => { databaseForwardStopped = true; } };
  });
  const backend = makeBackend();
  expect(await backend.prepare()).toContain('image=registry.example/postgresql:18.1-test');
  const credentialURL = `postgres://${config.databaseRole}:synthetic-password@unrelated.example/${config.databaseName}`;
  const bound = new URL(await backend.controllerDatabaseURL(credentialURL));
  expect(bound.hostname).toBe('127.0.0.1');
  expect(bound.port).toBe('15432');
  expect(bound.username).toBe(config.databaseRole);
  expect(() => backend.assertControllerAddress('127.0.0.1')).not.toThrow();
  expect(() => backend.assertControllerAddress('::1')).not.toThrow();
  expect(() => backend.assertControllerAddress('10.0.0.99')).toThrow();
  await backend.finish();
  expect(databaseForwardStopped).toBe(true);
  expect(() => backend.assertControllerAddress('127.0.0.1')).toThrow();
  databaseForwardStopped = false;
  replacePrimaryDuringForward = true;
  await expect(backend.controllerDatabaseURL(credentialURL)).rejects.toThrow('already finished');
  const replacementCheck = makeBackend();
  await replacementCheck.prepare();
  await expect(replacementCheck.controllerDatabaseURL(credentialURL)).rejects.toThrow('primary changed');
  expect(databaseForwardStopped).toBe(true);
  expect(backend.evidence.databaseServerAddress).toBe('10.0.0.2');
  expect(backend.evidence.destinationMatched).toBe(false);
  failStorage = true;
  await expect(new KubernetesCapacity(config, m, execute).prepare()).rejects.toThrow('storage');
});

import { capacityCommand, destinationDatabaseSetup, destinationTimingLog } from './capacity-kubernetes';

test('failing subprocess and SQL setup with credential-bearing errors never expose diagnostics', async () => {
  const secret = 'postgres://synthetic:private-password@db.example/benchmark?token=private-token';
  for (const work of [
    () => capacityCommand(['bun', '-e', 'console.error(process.argv[1]);process.exit(1)', secret]),
    () => capacityCommand(['/missing-capacity-binary', secret]),
    () => destinationDatabaseSetup(async () => { throw new Error('database failure ' + secret); }),
  ]) {
    let error: unknown;
    try { await work(); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(Error);
    const message = String(error);
    expect(message).toContain('diagnostics withheld');
    expect(message).not.toContain('private-password');
    expect(message).not.toContain('private-token');
    expect(message).not.toContain('postgres://');
  }
  const eventId = 'd'.repeat(64);
  const logs = destinationTimingLog('password=private-password\n' + JSON.stringify({ type: 'moderation_admission_timing', eventId, innerAdmissionMs: 2, database: secret, token: 'private-token' }));
  expect(JSON.parse(logs)).toEqual({ type: 'moderation_admission_timing', eventId, innerAdmissionMs: 2 });
  expect(logs).not.toContain('private-');
});

import { capacityContractForEntrypoint } from './strfry-capacity';

test('entrypoint replay binds the reviewed contract to the exact image and preserves full validation', () => {
  const identity = { imageId: 'sha256:' + 'a'.repeat(64), sourceSha: sha, platform: 'linux/amd64' };
  expect(() => capacityContractForEntrypoint({ imageId: 'sha256:' + 'c'.repeat(64) }, identity)).toThrow('image identity');
  expect(() => capacityContractForEntrypoint({ imageId: identity.imageId, version: 1 }, identity)).toThrow('Invalid capacity contract');
});

test('keeps an uncorrelated emitter line aggregate, without inventing correlation or exposing extra fields', () => {
  // strfryPlugin omits eventId for a frame it could not verify, as does an image
  // predating verified correlation; the filter must not supply one.
  const emitted = { type: 'moderation_admission_timing', innerAdmissionMs: 3, action: 'accept' };
  const filtered = destinationTimingLog(JSON.stringify({ ...emitted, database: 'postgres://synthetic:private-password@db.example/benchmark', token: 'private-token' }));
  expect(JSON.parse(filtered)).toEqual({ type: emitted.type, innerAdmissionMs: emitted.innerAdmissionMs });
  expect(JSON.parse(filtered).eventId).toBeUndefined();
  expect(filtered).not.toContain('private-');
  const repeated = destinationTimingLog(JSON.stringify(emitted) + '\n' + JSON.stringify({ ...emitted, innerAdmissionMs: 5 }));
  expect(repeated.split('\n')).toHaveLength(2);
  expect(repeated).not.toContain('eventId');
});

test('a privileged login cannot masquerade as the dedicated benchmark current role', () => {
  const disguised = { ...db, login: 'synthetic_privileged_login', loginCanLogin: true };
  expect(() => benchmarkDatabaseGuard(config, disguised)).toThrow();
});

import { benchmarkURLGuard } from './capacity-kubernetes';
test('both benchmark connection paths refuse startup-role URL overrides and privileged usernames', () => {
  const valid = 'postgres://' + config.databaseRole + ':synthetic-password@db.example/' + config.databaseName;
  expect(() => benchmarkURLGuard(config, valid)).not.toThrow();
  for (const url of [valid + '?options=-c%20role%3D' + config.databaseRole, valid + '?session_authorization=' + config.databaseRole, valid.replace(config.databaseRole + ':', 'postgres:')]) {
    expect(() => benchmarkURLGuard(config, url)).toThrow('diagnostics withheld');
  }
  // The same self-contained guard is embedded in the image-side credential probe.
  const embedded = new Function('return ' + benchmarkURLGuard.toString())();
  expect(() => embedded(config, valid + '?options=-c%20role%3Dsynthetic_role')).toThrow();
});

import { capacityRelayName } from './capacity-kubernetes';
import { REQUIRED_CAPACITY_CASES } from '../../packages/moderation/src/capacityContract';
test('every required case yields a valid owned Pod name, including cases whose ids contain underscores', () => {
  // The harness label is `capacity-` plus 20 hex characters.
  const label = 'capacity-' + 'a'.repeat(20);
  expect(REQUIRED_CAPACITY_CASES.some(id => id.includes('_'))).toBe(true);
  for (const id of REQUIRED_CAPACITY_CASES) {
    const name = capacityRelayName(label, id, 123);
    expect(() => benchmarkPod(config, { ...matrix }, name)).not.toThrow();
    expect(name).not.toContain('_');
  }
  expect(capacityRelayName(label, 'cache_entries', 7)).toBe(label + '-cache-entries-7');
});

import { refreshEntrypointObservation } from './strfry-capacity';
test('entrypoint replay does not ask the operator to observe a policy with a rekey pending', async () => {
  const observed: string[] = [];
  const capacity = { observeCurrent: async (org: string, community: string) => { observed.push(org + '/' + community); throw new Error('Capacity policy unavailable'); } };
  // An accepted rekey sets rekeyPending; the next repetition must not call the refusing observer.
  expect(await refreshEntrypointObservation(capacity, { rekeyPending: true }, 'org', 'room')).toBe(false);
  expect(observed).toEqual([]);
  // Without a pending rekey the observation is still taken, and its refusal still surfaces.
  await expect(refreshEntrypointObservation(capacity, { rekeyPending: false }, 'org', 'room')).rejects.toThrow('Capacity policy unavailable');
  expect(observed).toEqual(['org/room']);
  expect(await refreshEntrypointObservation(undefined, { rekeyPending: false }, 'org', 'room')).toBe(false);
});

import { SafeDiagnostic } from './capacity-kubernetes';
import { caseFailureReason } from './strfry-capacity';
test('a destination case keeps harness-authored reasons and withholds everything else', async () => {
  const secret = 'postgres://synthetic:private-password@db.example/benchmark';
  // Fixed-text harness failures stay readable so a config error is not mistaken for a cluster fault.
  expect(caseFailureReason(new SafeDiagnostic('Invalid owned benchmark Pod name'), true)).toBe('Invalid owned benchmark Pod name');
  expect(() => { try { benchmarkPod(config, matrix, 'capacity_bad_name'); } catch (e) { expect(caseFailureReason(e, true)).toBe('Invalid owned benchmark Pod name'); throw e; } }).toThrow();
  // Arbitrary errors (driver, subprocess, parse) may carry credentials and stay withheld on a destination.
  expect(caseFailureReason(new Error('connect failed ' + secret), true)).toBe('Destination sample failed (diagnostics withheld)');
  expect(caseFailureReason('not an error', true)).toBe('Destination sample failed (diagnostics withheld)');
  // The local Docker backend has nothing to withhold.
  expect(caseFailureReason(new Error('docker said no'), false)).toBe('docker said no');
  expect(caseFailureReason(undefined, false)).toBe('measurement failed');
  // Database guard failures name the violated precondition instead of one generic sentence.
  await expect(destinationDatabaseSetup(async () => { benchmarkDatabaseGuard(config, { ...db, populatedTables: 3 }); })).rejects.toThrow('empty migrated dedicated database');
  let error: unknown;
  try { await destinationDatabaseSetup(async () => { throw new Error('driver failure ' + secret); }); } catch (e) { error = e; }
  expect(String(error)).toContain('diagnostics withheld');
  expect(String(error)).not.toContain('private-password');
});

import { rendezvous } from './strfry-capacity';
test('concurrent samples finish preparation before any of them sends', async () => {
  const order: string[] = [];
  const gate = rendezvous(4);
  await Promise.all([0, 40, 10, 25].map(async (delay, n) => {
    await Bun.sleep(delay); order.push('prepared:' + n);
    await gate.wait(); order.push('send:' + n);
  }));
  const lastPrepared = Math.max(...order.flatMap((entry, i) => entry.startsWith('prepared') ? [i] : []));
  const firstSend = Math.min(...order.flatMap((entry, i) => entry.startsWith('send') ? [i] : []));
  expect(lastPrepared).toBeLessThan(firstSend);
});
test('a sample whose preparation fails abandons the gate instead of stranding the others', async () => {
  const gate = rendezvous(3);
  const released = Promise.all([gate.wait(), gate.wait()]);
  gate.abandon();
  expect(await Promise.race([released.then(() => 'released'), Bun.sleep(500).then(() => 'stranded')])).toBe('released');
});

import { POD_LIFETIME_SECONDS } from './capacity-kubernetes';
import { cleanupOnInterrupt } from './strfry-capacity';
test('benchmark Pods are bounded in lifetime so a skipped cleanup cannot strand them', () => {
  const pod = benchmarkPod(config, matrix, 'capacity-synthetic-1');
  expect(pod.spec.activeDeadlineSeconds).toBe(POD_LIFETIME_SECONDS);
  expect(POD_LIFETIME_SECONDS).toBeGreaterThan(3600);
  expect(POD_LIFETIME_SECONDS).toBeLessThanOrEqual(24 * 3600);
});

test('removal retains PVC files and deletes only the owned UID even if a name is reused', async () => {
  const calls: string[][] = [];
  let uid = 'owned-uid';
  const execute = async (args: string[]) => {
    calls.push(args);
    if (args.includes('get') && args.includes('pod')) return JSON.stringify({ metadata: { name: 'capacity-synthetic-1', uid } });
    return '';
  };
  const backend = new KubernetesCapacity(config, { ...fullMatrix, ...matrix } as any, execute);
  (backend as any).pods.set('capacity-synthetic-1', { uid: 'owned-uid' });
  uid = 'replacement';
  await expect(backend.remove('capacity-synthetic-1')).rejects.toThrow('ownership');
  expect(calls.some(c => c.includes('rm'))).toBe(false);
  uid = 'owned-uid';
  await backend.remove('capacity-synthetic-1');
  expect(calls.some(c => c.includes('exec'))).toBe(false);
  expect(calls.some(c => c.includes('delete'))).toBe(true);
  // An interrupt may finish the backend while a creation is still in flight.
  await backend.finish();
  await expect(backend.start('capacity-synthetic-2', '/missing', '/missing')).rejects.toThrow('already finished');
  expect(calls.some(c => c.includes('create'))).toBe(false);
});

test('an interrupt runs cleanup, reports a failure without leaking detail, and exits with the signal status', async () => {
  const exits: number[] = [], reports: string[] = [];
  const done = new Promise<void>(resolve => {
    const stop = cleanupOnInterrupt(async () => { throw new Error('cleanup failed postgres://synthetic:private-password@db.example/x'); }, code => { exits.push(code); stop(); resolve(); }, message => reports.push(message));
    process.emit('SIGTERM', 'SIGTERM');
  });
  await done;
  expect(exits).toEqual([143]);
  expect(reports).toEqual(['Capacity cleanup after interrupt failed: diagnostics withheld']);
  expect(process.listenerCount('SIGTERM')).toBe(0);
});

import { chmod } from 'node:fs/promises';
test('the loopback Docker script cannot be redirected to a live cluster by leftover destination settings', async () => {
  const bin = await mkdtemp(join(tmpdir(), 'capacity-script-test-'));
  try {
    const dump = join(bin, 'env.txt');
    await writeFile(join(bin, 'docker'), '#!/bin/sh\necho sha256:' + 'e'.repeat(64) + '\n');
    await writeFile(join(bin, 'bun'), '#!/bin/sh\nenv > ' + dump + '\n');
    await chmod(join(bin, 'docker'), 0o755); await chmod(join(bin, 'bun'), 0o755);
    const run = Bun.spawn(['bash', 'scripts/test-strfry-capacity.sh'], { cwd: join(import.meta.dir, '..', '..'), stdout: 'pipe', stderr: 'pipe', env: { PATH: bin + ':' + process.env.PATH, HOME: process.env.HOME ?? '/', STRFRY_TEST_IMAGE: 'synthetic', CAPACITY_KUBERNETES_CONFIG: '/synthetic/destination.json', CAPACITY_EXECUTE_DESTINATION: '1', CAPACITY_DATABASE_URL: 'postgres://synthetic:private-password@db.example/x' } });
    expect(await run.exited).toBe(0);
    const seen = await Bun.file(dump).text();
    expect(seen).toContain('STRFRY_TEST_IMAGE=sha256:' + 'e'.repeat(64));
    for (const name of ['CAPACITY_KUBERNETES_CONFIG', 'CAPACITY_EXECUTE_DESTINATION', 'CAPACITY_DATABASE_URL']) expect(seen).not.toContain(name + '=');
  } finally { await rm(bin, { recursive: true, force: true }); }
});

import { forward } from './capacity-kubernetes';
test('a long-lived port-forward is drained so chatty kubectl output cannot stall it, and its exit is observable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'capacity-forward-test-'));
  let f: Awaited<ReturnType<typeof forward>> | undefined;
  try {
    const marker = join(dir, 'finished'), script = join(dir, 'kubectl');
    // After the ready line, write far more than any pipe buffer to both streams.
    // One writer produces the output without spending the deadline spawning
    // 1,200 head/tr processes on hosts where process creation is slower.
    await writeFile(script, `#!/usr/bin/env bun\nconsole.log("Forwarding from 127.0.0.1:41234 -> 7777");\nawait Bun.write(Bun.stderr, 'x'.repeat(3000000));\nawait Bun.write(Bun.stdout, 'y'.repeat(3000000));\nawait Bun.write(${JSON.stringify(marker)}, 'done');\nsetInterval(() => {}, 1000);\n`);
    await chmod(script, 0o755);
    f = await forward([script, 'pod/synthetic']);
    expect(f.url).toBe('ws://127.0.0.1:41234');
    for (let n = 0; n < 100 && !await Bun.file(marker).exists(); n++) await Bun.sleep(50);
    expect(await Bun.file(marker).exists()).toBe(true);
    expect(f.alive!()).toBe(true);
    f.stop();
    for (let n = 0; n < 100 && f.alive!(); n++) await Bun.sleep(20);
    expect(f.alive!()).toBe(false);
  } finally { f?.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('a dead forward is reported with a readable reason before any sample runs', async () => {
  const backend = new KubernetesCapacity(config, { ...fullMatrix, ...matrix } as any, async () => '');
  expect(() => backend.assertTransportAlive()).not.toThrow();
  (backend as any).databaseForward = { url: 'ws://127.0.0.1:1', stop() {}, alive: () => false };
  expect(() => backend.assertTransportAlive()).toThrow('database transport exited');
  (backend as any).databaseForward = { url: 'ws://127.0.0.1:1', stop() {}, alive: () => true };
  (backend as any).pods.set('capacity-synthetic-1', { uid: 'u', forward: { url: 'ws://127.0.0.1:2', stop() {}, alive: () => false } });
  expect(() => backend.assertTransportAlive()).toThrow('relay transport exited');
});

import { childEnvironment } from './capacity-kubernetes';
test('kubectl, git and docker children never inherit the benchmark credential or other harness settings', async () => {
  const before = { url: process.env.CAPACITY_DATABASE_URL, config: process.env.CAPACITY_KUBERNETES_CONFIG };
  process.env.CAPACITY_DATABASE_URL = 'postgres://synthetic:private-password@db.example/benchmark';
  process.env.CAPACITY_KUBERNETES_CONFIG = '/synthetic/destination.json';
  try {
    const env = childEnvironment();
    expect(Object.keys(env).filter(key => key.startsWith('CAPACITY_'))).toEqual([]);
    // Everything else, including what kubectl's credential plugins need, passes through.
    expect<string | undefined>(env.PATH).toBe(process.env.PATH);
    expect(childEnvironment({ KUBECONFIG: '/k', CLOUDSDK_CONFIG: '/c', CAPACITY_DATABASE_URL: 'x', UNSET: undefined })).toEqual({ KUBECONFIG: '/k', CLOUDSDK_CONFIG: '/c' });
    // The real spawn path, as the driver uses it.
    const seen = await capacityCommand(['bun', '-e', 'console.log(JSON.stringify(Object.keys(process.env).filter(k => k.startsWith("CAPACITY_"))))']);
    expect(JSON.parse(seen)).toEqual([]);
    expect(seen).not.toContain('private-password');
  } finally {
    for (const [key, value] of [['CAPACITY_DATABASE_URL', before.url], ['CAPACITY_KUBERNETES_CONFIG', before.config]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

import { finalizeCapacityMeasurement, realpathOfFuture } from './strfry-capacity';
import { mkdir, realpath, symlink } from 'node:fs/promises';
test('cleanup reports the first failure, runs every step, and surfaces the later failures instead of replacing it', async () => {
  const ran: string[] = [], suppressed: string[] = [];
  const fail = (name: string) => () => { ran.push(name); throw new Error(name + ' failed'); };
  await expect(finalizeCapacityMeasurement(async () => { ran.push('artifacts'); throw new Error('artifacts failed'); }, [fail('pods'), () => { ran.push('temp'); }, fail('forward')], error => suppressed.push((error as Error).message))).rejects.toThrow('artifacts failed');
  expect(ran).toEqual(['artifacts', 'pods', 'temp', 'forward']);
  expect(suppressed).toEqual(['pods failed', 'forward failed']);
  // A cleanup failure alone is still the failure, and a reporter that throws cannot change that.
  await expect(finalizeCapacityMeasurement(async () => {}, [fail('pods')], () => { throw new Error('reporter broke'); })).rejects.toThrow('pods failed');
  await finalizeCapacityMeasurement(async () => {}, [() => {}]);
});

test('the output guard sees where mkdir would really write, through symlinks and not-yet-created directories', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'capacity-realpath-test-'));
  try {
    await mkdir(join(dir, 'checkout'));
    await symlink(join(dir, 'checkout'), join(dir, 'link'));
    const real = await realpath(dir);
    expect(await realpathOfFuture(join(dir, 'link', 'reports', 'run'))).toBe(join(real, 'checkout', 'reports', 'run'));
    // That resolved location is what destinationOutputGuard must refuse.
    expect(() => destinationOutputGuard(join(real, 'checkout', 'reports', 'run'), join(real, 'checkout'))).toThrow();
    expect(await realpathOfFuture(join(dir, 'new', 'deep', 'path'))).toBe(join(real, 'new', 'deep', 'path'));
    expect(await realpathOfFuture(dir)).toBe(real);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

import { quantity } from './capacity-kubernetes';
test('Kubernetes quantities compare by value, not by spelling', async () => {
  expect(quantity('1Gi')).toBe(1073741824);
  expect(quantity('1024Mi')).toBe(1073741824);
  expect(quantity('1073741824')).toBe(1073741824);
  expect(quantity(1073741824)).toBe(1073741824);
  expect(quantity('0.5Gi')).toBe(536870912);
  expect(quantity('1G')).toBe(1e9);
  expect(quantity('1024M')).toBe(1.024e9);
  expect(quantity('1Ti')).toBe(2 ** 40);
  expect(quantity('129e6')).toBe(129e6);
  expect(quantity('1E3')).toBe(1000);
  expect(quantity('2')).toBe(quantity('2000m'));
  expect(quantity('250m')).toBe(0.25);
  expect(quantity('100m')).toBe(0.1);
  expect(quantity(0.25)).toBe(quantity('250m'));
  expect(quantity(undefined)).toBeNaN();
  for (const bad of ['', 'abc', '1 Gi', '-1', '1Gb', '1gi', 'Gi']) expect(() => quantity(bad)).toThrow('Unsupported Kubernetes quantity');
});

test('preflight accepts the same storage size spelled differently and still refuses a different one', async () => {
  const m = { ...fullMatrix, ...matrix } as any;
  const relay = benchmarkPod(config, m, 'capacity-synthetic-1').spec.containers[0];
  // The deployment states its limits in other spellings of the same values.
  relay.resources = { requests: { cpu: '250m', memory: '256Mi' }, limits: { cpu: '2000m', memory: '1024Mi' } };
  const claim = (size: string, volumeName: string) => ({ metadata: { labels: { 'divine.video/capacity-benchmark': 'true' } }, status: { phase: 'Bound' }, spec: { volumeName, storageClassName: 'synthetic-rwo', volumeMode: 'Filesystem', accessModes: ['ReadWriteOnce'], resources: { requests: { storage: size } } } });
  const run = (benchmark: string, destination: string) => new KubernetesCapacity(config, m, async (args: string[]) => {
    if (args.includes('deployment')) return JSON.stringify({ spec: { template: { spec: { containers: [relay] } } } });
    if (args.includes('pvc')) return JSON.stringify(args.includes('capacity-data') ? claim(benchmark, 'benchmark-pv') : claim(destination, 'production-pv'));
    if (args.includes('namespace')) return JSON.stringify({ metadata: { name: config.namespace, labels: { 'divine.video/capacity-benchmark': 'true' } } });
    if (args.includes('networkpolicies')) return JSON.stringify({ items: [{ spec: { podSelector: {}, policyTypes: ['Ingress'], ingress: [] } }] });
    if (args.includes('cluster')) return JSON.stringify({ spec: { imageName: 'registry.example/postgresql:18.1-test', resources: { limits: { cpu: '2', memory: '8192Mi' } } }, status: { currentPrimary: 'synthetic-postgres-primary' } });
    if (args.includes('pod')) return JSON.stringify({ metadata: { uid: 'u' }, spec: { containers: [{ name: 'postgres', image: 'registry.example/postgresql:18.1-test', resources: { limits: { cpu: '2000m', memory: '8Gi' } } }] }, status: { podIP: '10.0.0.2' } });
    return JSON.stringify({ items: [] });
  }).prepare();
  await expect(run('20Gi', '20480Mi')).resolves.toContain('cnpg=');
  await expect(run('20Gi', '21Gi')).rejects.toThrow('storage size');
});

test('destination timing records follow the deployed emitter: verified lowercase IDs and non-negative durations only', () => {
  const line = (value: object) => destinationTimingLog(JSON.stringify({ type: 'moderation_admission_timing', ...value }));
  expect(line({ innerAdmissionMs: 3 })).not.toBe('');
  expect(line({ innerAdmissionMs: 0, eventId: 'a'.repeat(64) })).not.toBe('');
  expect(line({ innerAdmissionMs: -1 })).toBe('');
  expect(line({ innerAdmissionMs: 2, eventId: 'A'.repeat(64) })).toBe('');
  expect(line({ innerAdmissionMs: 2, eventId: 'abc' })).toBe('');
});

test('a Pod whose creation is still in flight when shutdown begins is removed before finish() resolves', async () => {
  const calls: string[][] = [];
  let releaseCreate!: () => void;
  const created = new Promise<void>(resolve => { releaseCreate = resolve; });
  const pod = { metadata: { name: 'capacity-synthetic-1', uid: 'late-uid' } };
  const execute = async (args: string[]) => {
    calls.push(args);
    if (args.includes('create')) { await created; return JSON.stringify(pod); }
    if (args.includes('get') && args.includes('pod')) return JSON.stringify(pod);
    return '';
  };
  const backend = new KubernetesCapacity(config, { ...fullMatrix, ...matrix } as any, execute);
  const starting = backend.start('capacity-synthetic-1', '/missing', '/missing').catch((e: Error) => e);
  while (!calls.some(c => c.includes('create'))) await Bun.sleep(1);
  let finished = false;
  const finishing = backend.finish().then(() => { finished = true; });   // the sweep sees an empty map
  await Bun.sleep(20);
  // The interrupt handler exits the process as soon as finish() resolves, so it must not
  // resolve while a creation could still produce a Pod nobody removes.
  expect(finished).toBe(false);
  expect(calls.some(c => c.includes('delete'))).toBe(false);
  releaseCreate();
  await finishing;
  expect(calls.some(c => c.includes('delete'))).toBe(true);
  expect(String(await starting)).toContain('already finished');
  expect(calls.some(c => c.includes('wait') && c.includes('--for=jsonpath={.status.phase}=Running'))).toBe(false);
  expect((backend as any).pods.size).toBe(0);
});

test('through the real interrupt handler, the process does not exit until a Pod created mid-signal is gone', async () => {
  const events: string[] = [];
  let releaseCreate!: () => void;
  const created = new Promise<void>(resolve => { releaseCreate = resolve; });
  const pod = { metadata: { name: 'capacity-synthetic-1', uid: 'late-uid' } };
  const execute = async (args: string[]) => {
    if (args.includes('create')) { events.push('create-sent'); await created; events.push('create-returned'); return JSON.stringify(pod); }
    if (args.includes('delete')) { events.push('delete'); return ''; }
    if (args.includes('get') && args.includes('pod')) return JSON.stringify(pod);
    return '';
  };
  const backend = new KubernetesCapacity(config, { ...fullMatrix, ...matrix } as any, execute);
  // Same shape as measureCapacity: the handler runs the cleanup list, which ends with finish(),
  // and exits when that settles.
  const exited = new Promise<number>(resolve => {
    const stop = cleanupOnInterrupt(() => finalizeCapacityMeasurement(async () => {}, [() => {}, () => backend.finish()]), code => { events.push('exit'); stop(); resolve(code); }, () => {});
  });
  const starting = backend.start('capacity-synthetic-1', '/missing', '/missing').catch((e: Error) => e);
  while (!events.includes('create-sent')) await Bun.sleep(1);
  process.emit('SIGTERM', 'SIGTERM');
  await Bun.sleep(30);
  expect(events).toEqual(['create-sent']);      // the old code had already exited by now
  releaseCreate();
  expect(await exited).toBe(143);
  await starting;
  expect(events).toEqual(['create-sent', 'create-returned', 'delete', 'exit']);
});

test('concurrent removals of one Pod share a single delete and neither reports a false failure', async () => {
  const calls: string[][] = [];
  let present = true;
  const execute = async (args: string[]) => {
    calls.push(args);
    if (args.includes('get') && args.includes('pod')) { if (!present) throw new Error('NotFound'); return JSON.stringify({ metadata: { name: 'capacity-synthetic-1', uid: 'u' } }); }
    if (args.includes('delete')) { await Bun.sleep(20); present = false; }
    return '';
  };
  const backend = new KubernetesCapacity(config, { ...fullMatrix, ...matrix } as any, execute);
  (backend as any).pods.set('capacity-synthetic-1', { uid: 'u' });
  await Promise.all([backend.close(), backend.finish()]);
  expect(calls.filter(c => c.includes('delete'))).toHaveLength(1);
});

import { settleCleanup } from './strfry-capacity';
test('a cleanup failure never replaces the measurement failure, and handlers outlive the cleanup', async () => {
  const suppressed: string[] = [];
  let stops = 0;
  const failing = async () => { throw new Error('Some owned benchmark Pods could not be removed'); };
  // The measurement already failed: its error stays the one that propagates.
  await settleCleanup(failing, true, () => { stops++; }, e => suppressed.push((e as Error).message));
  expect(suppressed).toEqual(['Some owned benchmark Pods could not be removed']);
  expect(stops).toBe(1);
  // Nothing failed before: the cleanup failure is the failure.
  await expect(settleCleanup(failing, false, () => { stops++; }, () => {})).rejects.toThrow('could not be removed');
  expect(stops).toBe(2);
  await settleCleanup(async () => {}, false, () => { stops++; }, () => {});
  expect(stops).toBe(3);
});

test('a signal that arrives during the final cleanup waits for it instead of killing the process mid-cleanup', async () => {
  const exits: number[] = [];
  let finishCleanup!: () => void;
  const cleaning = new Promise<void>(resolve => { finishCleanup = resolve; });
  // The shared, idempotent cleanup promise the harness hands to both paths.
  const stop = cleanupOnInterrupt(() => cleaning, code => { exits.push(code); }, () => {});
  let listenersDuringCleanup = -1;
  const settled = settleCleanup(async () => { listenersDuringCleanup = process.listenerCount('SIGTERM'); await cleaning; }, false, stop, () => {});
  await Bun.sleep(5);
  process.emit('SIGTERM', 'SIGTERM');           // arrives while cleanup is still running
  await Bun.sleep(20);
  expect(exits).toEqual([]);                    // it waits; it did not exit or kill anything yet
  finishCleanup();
  await settled; await Bun.sleep(20);
  expect(listenersDuringCleanup).toBe(1);       // still installed while cleanup ran
  expect(exits).toEqual([143]);
  expect(process.listenerCount('SIGTERM')).toBe(0);
});

test('a relay that never restarts and a forward that never becomes ready are reported with their own reasons', async () => {
  // These are exactly how a SIGTERM that PID 1 ignores would surface; an operator must see them.
  const pod = { metadata: { name: 'capacity-synthetic-1', uid: 'u' }, status: { containerStatuses: [{ restartCount: 0, state: { running: {} } }] } };
  const backend = new KubernetesCapacity(config, { ...fullMatrix, ...matrix } as any, async (args: string[]) => args.includes('get') && args.includes('pod') ? JSON.stringify(pod) : '');
  (backend as any).pods.set('capacity-synthetic-1', { uid: 'u' });
  const restartError = await backend.restart('capacity-synthetic-1', 2, 1).catch((e: unknown) => e);
  expect(restartError).toBeInstanceOf(SafeDiagnostic);
  expect(caseFailureReason(restartError, true)).toBe('Benchmark container did not restart with retained data');

  const dir = await mkdtemp(join(tmpdir(), 'capacity-forward-fail-'));
  try {
    const script = join(dir, 'kubectl');
    await writeFile(script, '#!/bin/sh\nexit 1\n'); await chmod(script, 0o755);
    const forwardError = await forward([script, 'pod/synthetic']).catch((e: unknown) => e);
    expect(forwardError).toBeInstanceOf(SafeDiagnostic);
    expect(caseFailureReason(forwardError, true)).toBe('Private benchmark port-forward did not become ready');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const acquisition of ['database', 'relay'] as const) {
  test(`finish waits for an in-flight ${acquisition} forward and stops it before resolving`, async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let opening = false, stopped = false, finished = false;
    const pod = { metadata: { uid: 'u' }, status: { podIP: '10.0.0.7', containerStatuses: [{ restartCount: 1, state: { running: {} } }] } };
    let reads = 0;
    const backend = new KubernetesCapacity(config, { ...fullMatrix, ...matrix } as any,
      async args => { if (!args.includes('get')) return ''; pod.status.containerStatuses[0].restartCount = reads++ === 0 ? 0 : 1; return JSON.stringify(pod); },
      async () => { opening = true; await pending; return { url: 'ws://127.0.0.1:43210', stop: () => { stopped = true; } }; });
    (backend as any).databasePrimary = { name: 'primary', uid: 'u', address: '10.0.0.7' };
    (backend as any).pods.set('capacity-synthetic-1', { uid: 'u' });
    const acquiring = (acquisition === 'database'
      ? backend.controllerDatabaseURL(`postgres://${config.databaseRole}:synthetic@ignored/${config.databaseName}`)
      : backend.restart('capacity-synthetic-1', 1, 1)).catch((error: unknown) => error);
    while (!opening) await Bun.sleep(1);
    const finishing = backend.finish().then(() => { finished = true; });
    await Bun.sleep(10);
    expect(finished).toBe(false);
    release();
    expect(String(await acquiring)).toContain('already finished');
    await finishing;
    expect(stopped).toBe(true);
    expect(finished).toBe(true);
  });
}

for (const failure of ['unreadable', 'replaced'] as const) {
  test(`finish stops every local forward even when an owned Pod is ${failure}`, async () => {
    const stops: string[] = [], deletes: string[] = [];
    const backend = new KubernetesCapacity(config, { ...fullMatrix, ...matrix } as any, async args => {
      if (args.includes('get') && args.includes('broken')) {
        if (failure === 'unreadable') throw new Error('synthetic API read failure');
        return JSON.stringify({ metadata: { uid: 'replacement' } });
      }
      if (args.includes('get')) return JSON.stringify({ metadata: { uid: 'owned' } });
      if (args.includes('delete')) deletes.push(args.join(' '));
      return '';
    });
    (backend as any).pods.set('broken', { uid: 'owned', forward: { stop: () => stops.push('broken') } });
    (backend as any).pods.set('healthy', { uid: 'owned', forward: { stop: () => stops.push('healthy') } });
    (backend as any).databaseForward = { stop: () => stops.push('database') };
    await expect(backend.finish()).rejects.toThrow('could not be removed');
    expect(stops).toEqual(['broken', 'healthy', 'database']);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toContain('/pods/healthy');
  });
}
