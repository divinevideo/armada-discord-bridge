import { describe, expect, test } from 'bun:test';
import { benchmarkDatabaseGuard, benchmarkNamespaceGuard, benchmarkPod, destinationConfig, destinationOutputGuard, verifyRelayReadback } from './capacity-kubernetes';

const image = 'registry.example/relay@sha256:' + 'a'.repeat(64);
const sha = 'b'.repeat(40);
const config = { context: 'explicit-production', namespace: 'concord-capacity-synthetic', image, sourceSha: sha, databaseCluster: { namespace: 'postgres-clusters', name: 'postgres' }, relayDeployment: { namespace: 'armada-chat', name: 'concord-relay', container: 'relay' }, relayRequests: { cpu: 0.25, memoryBytes: 268435456 }, relayStorage: { claimName: 'capacity-data', productionClaimName: 'concord-relay' }, databaseSecret: 'benchmark-database', databaseSecretKey: 'DATABASE_URL', databaseName: 'concord_capacity_synthetic', databaseRole: 'concord_capacity_synthetic', postgresVersion: '18.1', platform: 'linux/amd64' };
const matrix = { cpu: 2, memoryBytes: 1073741824, databaseCpu: 2, databaseMemoryBytes: 8589934592 };
const db = { database: config.databaseName, role: config.databaseRole, login: config.databaseRole, loginCanLogin: true, serverVersion: '18.1', superuser: false, createDatabase: false, createRole: false, ownsDatabase: true, populatedTables: 0, schemaPresent: true, roleMemberships: 0 };

describe('isolated destination measurement', () => {
  test('requires an immutable image, explicit context and isolated namespace/database', () => {
    expect(destinationConfig(config)).toEqual(config);
    for (const change of [{ context: '' }, { namespace: 'armada-chat' }, { image: 'registry.example/relay:latest' }, { databaseName: 'bridge' }, { databaseRole: 'concord_operator' }, { sourceSha: 'short' }, { platform: 'linux/arm64' }]) {
      expect(() => destinationConfig({ ...config, ...change })).toThrow();
    }
  });
  test('refuses populated, privileged, mismatched or wrong-version databases', () => {
    expect(() => benchmarkDatabaseGuard(config, db)).not.toThrow();
    for (const change of [{ loginCanLogin: false }, { database: 'bridge' }, { role: 'postgres' }, { serverVersion: '16.4' }, { populatedTables: 1 }, { schemaPresent: false }, { roleMemberships: 1 }, { superuser: true }, { createDatabase: true }, { createRole: true }, { ownsDatabase: false }]) {
      expect(() => benchmarkDatabaseGuard(config, { ...db, ...change })).toThrow();
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
});

test('destination preflight compares the selected relay, separate PVC and running CNPG primary', async () => {
  const m = { ...fullMatrix, ...matrix } as any;
  const relay = benchmarkPod(config, m, 'capacity-synthetic-1').spec.containers[0];
  const storage = { metadata: { labels: { 'divine.video/capacity-benchmark': 'true' } }, status: { phase: 'Bound' }, spec: { volumeName: 'synthetic-benchmark-pv', storageClassName: 'synthetic-rwo', volumeMode: 'Filesystem', accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '20Gi' } } } };
  let failStorage = false;
  const execute = async (args: string[]) => {
    expect(args).not.toContain('create'); expect(args).not.toContain('delete');
    if (args.includes('deployment')) return JSON.stringify({ spec: { template: { spec: { containers: [relay] } } } });
    if (args.includes('pvc')) return JSON.stringify(args.includes('capacity-data') ? storage : { ...storage, spec: { ...storage.spec, volumeName: failStorage ? 'synthetic-benchmark-pv' : 'synthetic-production-pv' } });
    if (args.includes('namespace')) return JSON.stringify({ metadata: { name: config.namespace, labels: { 'divine.video/capacity-benchmark': 'true' } } });
    if (args.includes('networkpolicies')) return JSON.stringify({ items: [{ spec: { podSelector: {}, policyTypes: ['Ingress'], ingress: [] } }] });
    if (args.includes('cluster')) return JSON.stringify({ spec: { imageName: 'registry.example/postgresql:18.1-test', resources: { limits: { cpu: '2', memory: '8Gi' } } }, status: { currentPrimary: 'synthetic-postgres-primary' } });
    if (args.includes('pod')) return JSON.stringify({ spec: { containers: [{ name: 'postgres', image: 'registry.example/postgresql:18.1-test', resources: { limits: { cpu: '2', memory: '8Gi' } } }] }, status: { podIP: '10.0.0.2' } });
    return JSON.stringify({ items: [] });
  };
  const backend = new KubernetesCapacity(config, m, execute);
  expect(await backend.prepare()).toContain('image=registry.example/postgresql:18.1-test');
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

test('retains the production emitter timing shape without inventing event correlation or exposing extra fields', () => {
  // strfryPlugin emits aggregate timing; only the calibration launcher adds eventId.
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
