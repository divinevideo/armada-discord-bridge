/** Private synthetic destination measurements. Importing never contacts Kubernetes or SQL. */
import { readFile, readdir } from 'node:fs/promises';
import { join, isAbsolute, relative, resolve } from 'node:path';
import type { CapacityMatrix } from './strfry-capacity';

export interface DestinationConfig {
  context: string; namespace: string; image: string; sourceSha: string; platform: string;
  databaseCluster: { namespace: string; name: string }; relayStorage: { claimName: string; productionClaimName: string }; relayDeployment: { namespace: string; name: string; container: string }; relayRequests: { cpu: number; memoryBytes: number }; databaseSecret: string; databaseSecretKey: string;
  databaseName: string; databaseRole: string; postgresVersion: string;
}
export interface DatabaseObservation {
  database: string; role: string; login: string; loginCanLogin: boolean; serverVersion: string; superuser: boolean; createDatabase: boolean;
  createRole: boolean; ownsDatabase: boolean; populatedTables: number; schemaPresent: boolean; roleMemberships: number; serverAddress?: string;
}
type Json = Record<string, any>;
type Resources = Pick<CapacityMatrix, 'cpu' | 'memoryBytes' | 'databaseCpu' | 'databaseMemoryBytes'>;
export type Run = (args: string[], input?: string) => Promise<string>;
function need(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
export function destinationConfig(value: unknown): DestinationConfig {
  const c = value as DestinationConfig;
  need(c && /^[a-zA-Z0-9_.:-]+$/.test(c.context ?? ''), 'Explicit Kubernetes context required');
  need(/^concord-capacity-[a-z0-9-]+$/.test(c.namespace ?? ''), 'Dedicated capacity namespace required');
  need(/^[a-zA-Z0-9./_-]+@sha256:[0-9a-f]{64}$/.test(c.image ?? ''), 'Pinned destination image required');
  need(/^[0-9a-f]{40}$/.test(c.sourceSha ?? '') && c.platform === 'linux/amd64', 'Native source/platform required');
  need(/^concord_capacity_[a-z0-9_]+$/.test(c.databaseName ?? '') && /^concord_capacity_[a-z0-9_]+$/.test(c.databaseRole ?? ''), 'Dedicated benchmark database and role required');
  need(c.postgresVersion === '18.1', 'Explicit PostgreSQL 18.1 destination required');
  need(Number.isFinite(c.relayRequests?.cpu) && c.relayRequests.cpu > 0 && Number.isSafeInteger(c.relayRequests?.memoryBytes) && c.relayRequests.memoryBytes > 0, 'Explicit relay request envelope required');
  for (const v of [c.databaseCluster?.namespace, c.databaseCluster?.name, c.relayDeployment?.namespace, c.relayDeployment?.name, c.relayDeployment?.container, c.relayStorage?.claimName, c.relayStorage?.productionClaimName, c.databaseSecret, c.databaseSecretKey]) need(typeof v === 'string' && /^[a-zA-Z0-9_.-]+$/.test(v), 'Explicit database metadata references required');
  return c;
}
export function destinationOutputGuard(output: string | undefined, checkout: string) {
  need(output && isAbsolute(output), 'Private absolute destination output directory required');
  const path = relative(resolve(checkout), resolve(output));
  need(path.startsWith('..' + '/') || isAbsolute(path), 'Destination reports must stay outside the checkout');
}
export function benchmarkURLGuard(c: Pick<DestinationConfig, 'databaseRole' | 'databaseName'>, value: string) {
  try {
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || decodeURIComponent(url.username) !== c.databaseRole || decodeURIComponent(url.pathname.slice(1)) !== c.databaseName || [...url.searchParams.keys()].some(key => key !== 'sslmode')) throw new Error();
  } catch { throw new Error('Dedicated benchmark URL identity or startup parameters are invalid (diagnostics withheld)'); }
}
export const BENCHMARK_IDENTITY_SQL = `SELECT pg_catalog.current_database() AS database,current_user AS role,session_user AS login,pg_catalog.host(pg_catalog.inet_server_addr()) AS "serverAddress",pg_catalog.split_part(pg_catalog.current_setting('server_version'),' ',1) AS "serverVersion",r.rolsuper AS superuser,r.rolcreatedb AS "createDatabase",r.rolcreaterole AS "createRole",r.rolcanlogin AS "loginCanLogin",pg_catalog.pg_get_userbyid(d.datdba)=current_user AS "ownsDatabase",(SELECT count(*)::int FROM pg_catalog.pg_auth_members WHERE member=r.oid) AS "roleMemberships" FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_database d ON d.datname=pg_catalog.current_database() WHERE r.rolname=session_user`;
export function benchmarkLoginGuard(c: DestinationConfig, o: Pick<DatabaseObservation, 'role' | 'login' | 'loginCanLogin' | 'superuser' | 'createDatabase' | 'createRole' | 'roleMemberships'>) {
  need(o.role === c.databaseRole && o.login === c.databaseRole, 'Both session login and current role must be the dedicated benchmark role');
  need(o.loginCanLogin === true && o.superuser === false && o.createDatabase === false && o.createRole === false && o.roleMemberships === 0, 'Benchmark login must be unprivileged and have no memberships');
}
export function benchmarkDatabaseGuard(c: DestinationConfig, o: DatabaseObservation) {
  benchmarkLoginGuard(c, o);
  need(o.database === c.databaseName && o.serverVersion === c.postgresVersion, 'Database identity/version does not match isolated target');
  need(o.ownsDatabase === true && o.populatedTables === 0 && o.schemaPresent === true, 'Benchmark requires an empty migrated dedicated database owned by its role');
}
export function benchmarkNamespaceGuard(c: DestinationConfig, namespace: Json, policies: Json[], pods: Json[], routes: Json[]) {
  need(namespace.metadata?.name === c.namespace && namespace.metadata?.labels?.['divine.video/capacity-benchmark'] === 'true', 'Namespace is not a marked synthetic benchmark');
  need(pods.length === 0 && routes.length === 0, 'Benchmark namespace must have no existing workloads or exposure');
  need(!policies.some(p => p.spec?.ingress?.length > 0), 'Additional ingress allowances defeat benchmark isolation');
  need(policies.some(p => Object.keys(p.spec?.podSelector ?? { invalid: true }).length === 0 && p.spec?.policyTypes?.includes('Ingress') && Array.isArray(p.spec?.ingress) && p.spec.ingress.length === 0), 'Default deny ingress required for isolated benchmark');
}
export function benchmarkPod(c: DestinationConfig, m: Resources, name: string) {
  need(name.length <= 63 && /^capacity-[a-z0-9-]+$/.test(name), 'Invalid owned benchmark Pod name');
  return { apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace: c.namespace, labels: { 'divine.video/capacity-benchmark': 'true' } }, spec: {
    hostNetwork: false, automountServiceAccountToken: false, restartPolicy: 'Always', terminationGracePeriodSeconds: 5,
    nodeSelector: { 'cloud.google.com/gke-provisioning': 'standard', 'kubernetes.io/arch': 'amd64' },
    securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001, seccompProfile: { type: 'RuntimeDefault' } },
    initContainers: [{ name: 'prepare-data', image: c.image, command: ['mkdir', '-p', '/storage/' + name],
      securityContext: { runAsNonRoot: true, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
      resources: { requests: { cpu: '10m', memory: '16Mi' }, limits: { cpu: '100m', memory: '64Mi' } },
      volumeMounts: [{ name: 'data', mountPath: '/storage' }],
    }],
    containers: [{ name: 'relay', image: c.image,
      // The operator uploads synthetic fixtures before the listener starts. No Service is created.
      command: ['sh', '-c', 'mkdir -p /data/db; while [ ! -f /capacity/ready ]; do sleep 0.1; done; exec /usr/local/bin/strfry --config=/data/strfry.conf relay'],
      env: [{ name: 'MODERATION_DATABASE_URL', valueFrom: { secretKeyRef: { name: c.databaseSecret, key: c.databaseSecretKey } } }, { name: 'MODERATION_CAPACITY_TIMING', value: '1' }],
      securityContext: { runAsNonRoot: true, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
      resources: { requests: { cpu: String(c.relayRequests.cpu), memory: String(c.relayRequests.memoryBytes) }, limits: { cpu: String(m.cpu), memory: String(m.memoryBytes) } },
      volumeMounts: [{ name: 'data', mountPath: '/data', subPath: name }, { name: 'fixtures', mountPath: '/capacity' }, { name: 'tmp', mountPath: '/tmp' }],
    }], volumes: [{ name: 'data', persistentVolumeClaim: { claimName: c.relayStorage.claimName } }, { name: 'fixtures', emptyDir: {} }, { name: 'tmp', emptyDir: { sizeLimit: '128Mi' } }],
  } };
}
function cpu(value: string | number): number { return typeof value === 'string' && value.endsWith('m') ? Number(value.slice(0, -1)) / 1000 : Number(value); }
function memory(value: string | number): number { const match = String(value).match(/^(\d+)(Ki|Mi|Gi)?$/); need(match, 'Unsupported memory quantity'); return Number(match[1]) * ({ Ki: 1024, Mi: 1048576, Gi: 1073741824 }[match[2] ?? ''] ?? 1); }
export function verifyRelayReadback(c: DestinationConfig, m: Resources, pod: Json, identity: Json, node: Json) {
  const container = pod.spec?.containers?.find((x: Json) => x.name === 'relay');
  const status = pod.status?.containerStatuses?.find((x: Json) => x.name === 'relay');
  need(container?.image === c.image && status?.imageID?.endsWith(c.image.split('@')[1]), 'Running relay digest mismatch');
  need(cpu(container.resources?.limits?.cpu) === m.cpu && memory(container.resources?.limits?.memory) === m.memoryBytes, 'Actual relay limits differ from matrix');
  need(cpu(container.resources?.requests?.cpu) === c.relayRequests.cpu && memory(container.resources?.requests?.memory) === c.relayRequests.memoryBytes, 'Actual relay requests differ from destination');
  need(identity.sourceSha === c.sourceSha && identity.platform === c.platform, 'Running image source/native platform mismatch');
  need(node.metadata?.labels?.['cloud.google.com/gke-provisioning'] === 'standard' && node.metadata?.labels?.['kubernetes.io/arch'] === 'amd64', 'Actual node is not native standard compute');
}
export async function destinationDatabaseSetup<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch { throw new Error('Isolated destination database validation failed (diagnostics withheld)'); }
}
export function destinationTimingLog(text: string): string {
  return text.split('\n').flatMap(line => {
    try {
      const value = JSON.parse(line.slice(line.indexOf('{')));
      if (value.type !== 'moderation_admission_timing' || !Number.isFinite(value.innerAdmissionMs)) return [];
      if ('eventId' in value && (typeof value.eventId !== 'string' || !/^[0-9a-f]{64}$/.test(value.eventId))) return [];
      // The deployed emitter is aggregate-only; calibration can add correlation.
      // Retaining an absent ID lets the sampler use only its single-flight fallback.
      return [JSON.stringify({ type: value.type, ...('eventId' in value ? { eventId: value.eventId } : {}), innerAdmissionMs: value.innerAdmissionMs })];
    } catch { return []; }
  }).join('\n');
}
export async function capacityCommand(args: string[], input?: string): Promise<string> {
  try {
    const child = Bun.spawn(args, { stdin: input === undefined ? 'ignore' : new Blob([input]), stdout: 'pipe', stderr: 'pipe' });
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited, new Response(child.stderr).text()]);
    if (code !== 0) throw new Error('process failure');
    return out.trim();
  } catch { throw new Error('Capacity Kubernetes command failed (diagnostics withheld)'); }
}

interface Forward { url: string; stop(): void }
async function forward(args: string[], remotePort = 7777): Promise<Forward> {
  const child = Bun.spawn([...args.slice(0, -1).map(arg => arg.startsWith('--request-timeout=') ? '--request-timeout=0' : arg), 'port-forward', args.at(-1)!, '--address=127.0.0.1', `:${remotePort}`], { stdout: 'pipe', stderr: 'pipe' });
  const reader = child.stdout.getReader(); let text = '';
  try {
    const started = Date.now();
    while (Date.now() - started < 30000) {
      const result = await Promise.race([reader.read(), Bun.sleep(30000).then(() => ({ done: true, value: undefined }))]);
      if (result.done) break;
      text += new TextDecoder().decode(result.value);
      const port = text.match(new RegExp(`Forwarding from 127\\.0\\.0\\.1:(\\d+) -> ${remotePort}`));
      if (port) return { url: `ws://127.0.0.1:${port[1]}`, stop: () => child.kill() };
    }
    throw new Error('Private benchmark port-forward did not become ready');
  } catch (e) { child.kill(); throw e; }
  finally { reader.releaseLock(); }
}

export class KubernetesCapacity {
  readonly config: DestinationConfig;
  readonly evidence: Json = { version: 1, certified: false, controllerModelVerified: false, destinationMatched: false, relayObservations: [] };
  private databasePrimary?: { name: string; uid: string; address: string };
  private databaseForward?: Forward;
  private pods = new Map<string, { uid: string; config: string; directory: string; forward?: Forward }>();
  constructor(c: unknown, private matrix: CapacityMatrix, private execute: Run = capacityCommand, private portForward = forward) { this.config = destinationConfig(c); }
  private args() { return ['kubectl', `--context=${this.config.context}`, '--request-timeout=30s', '-n', this.config.namespace]; }
  private async json(args: string[]) { return JSON.parse(await this.execute([...this.args(), ...args, '-o', 'json'])); }
  async prepare() {
    const c = this.config;
    const target = JSON.parse(await this.execute(['kubectl', `--context=${c.context}`, '--request-timeout=30s', '-n', c.relayDeployment.namespace, 'get', 'deployment', c.relayDeployment.name, '-o', 'json']));
    const relay = target.spec?.template?.spec?.containers?.find((x: Json) => x.name === c.relayDeployment.container);
    need(relay?.image === c.image && cpu(relay.resources?.limits?.cpu) === this.matrix.cpu && memory(relay.resources?.limits?.memory) === this.matrix.memoryBytes && cpu(relay.resources?.requests?.cpu) === c.relayRequests.cpu && memory(relay.resources?.requests?.memory) === c.relayRequests.memoryBytes, 'Selected relay deployment does not match benchmark image/resources');
    this.evidence.relayDeployment = { ...c.relayDeployment, image: relay.image, resources: relay.resources };
    const storage = await this.json(['get', 'pvc', c.relayStorage.claimName]);
    const sourceStorage = JSON.parse(await this.execute(['kubectl', `--context=${c.context}`, '--request-timeout=30s', '-n', c.relayDeployment.namespace, 'get', 'pvc', c.relayStorage.productionClaimName, '-o', 'json']));
    need(storage.metadata?.labels?.['divine.video/capacity-benchmark'] === 'true' && storage.status?.phase === 'Bound' && sourceStorage.status?.phase === 'Bound' && storage.spec?.volumeName && storage.spec.volumeName !== sourceStorage.spec?.volumeName, 'Separate bound benchmark storage required');
    for (const field of ['storageClassName', 'volumeMode', 'accessModes']) need(JSON.stringify(storage.spec[field]) === JSON.stringify(sourceStorage.spec[field]), 'Benchmark storage class/mode differs from destination');
    need(storage.spec.resources?.requests?.storage === sourceStorage.spec?.resources?.requests?.storage, 'Benchmark storage size differs from destination');
    this.evidence.relayStorage = { benchmark: { name: c.relayStorage.claimName, spec: storage.spec }, destination: { name: c.relayStorage.productionClaimName, spec: sourceStorage.spec } };
    const namespace = await this.json(['get', 'namespace', c.namespace]);
    const policies = await this.json(['get', 'networkpolicies']);
    const pods = await this.json(['get', 'pods']);
    const exposed = await this.json(['get', 'services,ingresses,httproutes']);
    benchmarkNamespaceGuard(c, namespace, policies.items, pods.items, exposed.items);
    const cluster = JSON.parse(await this.execute(['kubectl', `--context=${c.context}`, '--request-timeout=30s', '-n', c.databaseCluster.namespace, 'get', 'cluster', c.databaseCluster.name, '-o', 'json']));
    need(cluster.spec?.imageName?.includes('postgresql:18.1-') && cpu(cluster.spec?.resources?.limits?.cpu) === this.matrix.databaseCpu && memory(cluster.spec?.resources?.limits?.memory) === this.matrix.databaseMemoryBytes, 'Actual CNPG version/resources differ from matrix');
    need(typeof cluster.status?.currentPrimary === 'string', 'CNPG primary identity unavailable');
    const primary = JSON.parse(await this.execute(['kubectl', `--context=${c.context}`, '--request-timeout=30s', '-n', c.databaseCluster.namespace, 'get', 'pod', cluster.status.currentPrimary, '-o', 'json']));
    const database = primary.spec?.containers?.find((x: Json) => x.name === 'postgres');
    need(primary.status?.podIP && database?.image === cluster.spec.imageName && cpu(database.resources?.limits?.cpu) === this.matrix.databaseCpu && memory(database.resources?.limits?.memory) === this.matrix.databaseMemoryBytes, 'Running CNPG primary does not match expected destination envelope');
    need(typeof primary.metadata?.uid === 'string', 'CNPG primary UID unavailable');
    this.databasePrimary = { name: cluster.status.currentPrimary, uid: primary.metadata.uid, address: primary.status.podIP };
    this.evidence.databaseServerAddress = primary.status.podIP;
    this.evidence.databasePrimaryImageID = primary.status?.containerStatuses?.find((x: Json) => x.name === 'postgres')?.imageID;
    this.evidence.context = c.context; this.evidence.namespace = c.namespace; this.evidence.databaseCluster = { ...c.databaseCluster, image: cluster.spec.imageName, resources: cluster.spec.resources };
    return `cnpg=${c.databaseCluster.namespace}/${c.databaseCluster.name};image=${cluster.spec.imageName};cpus=${this.matrix.databaseCpu};memoryBytes=${this.matrix.databaseMemoryBytes}`;
  }
  async controllerDatabaseURL(credentials: string): Promise<string> {
    benchmarkURLGuard(this.config, credentials);
    need(this.databasePrimary && !this.databaseForward, 'Verified CNPG primary transport required');
    const anchor = this.databasePrimary;
    const args = ['kubectl', `--context=${this.config.context}`, '--request-timeout=30s', '-n', this.config.databaseCluster.namespace];
    const check = async () => {
      const pod = JSON.parse(await this.execute([...args, 'get', 'pod', anchor.name, '-o', 'json']));
      need(pod.metadata?.uid === anchor.uid && pod.status?.podIP === anchor.address, 'CNPG primary changed during transport binding');
    };
    await check();
    const f = await this.portForward([...args, 'pod/' + anchor.name], 5432);
    try {
      await check();
      const endpoint = new URL(f.url);
      need(endpoint.hostname === '127.0.0.1' && /^\d+$/.test(endpoint.port), 'Database forward is not a private loopback endpoint');
      const url = new URL(credentials);
      // A caller supplies credentials, never the destination. Only the owned
      // API-authenticated forward to the verified Pod/UID becomes a SQL endpoint.
      url.hostname = '127.0.0.1'; url.port = endpoint.port;
      this.databaseForward = f;
      this.evidence.controllerTransport = { context: this.config.context, namespace: this.config.databaseCluster.namespace, pod: anchor.name, uid: anchor.uid, address: anchor.address, localHost: '127.0.0.1', remotePort: 5432 };
      return url.toString();
    } catch (error) { f.stop(); throw error; }
  }
  assertControllerAddress(address: unknown) {
    need(this.databaseForward && this.databasePrimary, 'Controller connection has no owned primary transport');
    // Port-forward dials inside the Pod network namespace; PostgreSQL may see
    // loopback rather than PodIP. The owned forward, not this address, binds it.
    need(address === '127.0.0.1' || address === '::1' || address === this.databasePrimary.address, 'Controller server address is inconsistent with its owned primary transport');
  }
  async finish() {
    try { await this.close(); } finally { this.databaseForward?.stop(); this.databaseForward = undefined; }
  }
  private async owned(name: string) {
    const record = this.pods.get(name); need(record, 'Pod was not created by this measurement');
    const pod = await this.json(['get', 'pod', name]); need(pod.metadata.uid === record.uid, 'Benchmark Pod ownership changed'); return pod;
  }
  private async upload(name: string, path: string, data: string, executable = false) {
    need(/^\/(capacity\/[a-zA-Z0-9_.-]+|data\/strfry.conf)$/.test(path), 'Invalid fixture destination');
    await this.owned(name);
    await this.execute([...this.args(), 'exec', '-i', name, '-c', 'relay', '--', 'sh', '-c', `cat > ${path}.new && chmod ${executable ? '755' : '644'} ${path}.new && mv ${path}.new ${path}`], data);
  }
  async updateFixtures(directory: string) {
    const data = await readFile(join(directory, 'calibration.json'), 'utf8');
    for (const name of this.pods.keys()) await this.upload(name, '/capacity/calibration.json', data);
  }
  async start(name: string, config: string, directory: string, contract?: string, communities: [string, string][] = []) {
    const manifest = benchmarkPod(this.config, this.matrix, name);
    if (contract) (manifest.spec.containers[0].env as Json[]).push({ name: 'MODERATION_COMMUNITY_ORGS', value: JSON.stringify(Object.fromEntries(communities)) });
    // create, never apply/adopt an existing Pod; cleanup is restricted to its returned UID.
    const created = JSON.parse(await this.execute([...this.args(), 'create', '-f', '-', '-o', 'json'], JSON.stringify(manifest)));
    need(created.metadata?.uid, 'Created benchmark Pod has no UID');
    this.pods.set(name, { uid: created.metadata.uid, config, directory });
    await this.execute([...this.args(), 'wait', '--for=jsonpath={.status.phase}=Running', `pod/${name}`, '--timeout=180s']);
    const pod = await this.owned(name);
    const identity = JSON.parse(await this.execute([...this.args(), 'exec', name, '-c', 'relay', '--', 'bun', '-e', "console.log(JSON.stringify({sourceSha:process.env.MODERATION_SOURCE_SHA,platform:process.platform+'/'+(process.arch==='x64'?'amd64':process.arch)}))"]));
    const node = await this.json(['get', 'node', pod.spec.nodeName]);
    verifyRelayReadback(this.config, this.matrix, pod, identity, node);
    this.evidence.relayObservations.push({ image: manifest.spec.containers[0].image, imageID: pod.status.containerStatuses[0].imageID, node: pod.spec.nodeName, identity, resources: pod.spec.containers[0].resources });
    // Prove the mounted dedicated credential names the same isolated DB/role/version
    // before opening the relay; never print the URL or query errors.
    const remoteDb = JSON.parse(await this.execute([...this.args(), 'exec', name, '-c', 'relay', '--', 'bun', '-e', `import postgres from '/opt/divine/node_modules/postgres/src/index.js';${benchmarkURLGuard.toString()};let s;try{benchmarkURLGuard(${JSON.stringify({ databaseRole: this.config.databaseRole, databaseName: this.config.databaseName })},process.env.MODERATION_DATABASE_URL);s=postgres(process.env.MODERATION_DATABASE_URL,{max:1,onnotice:()=>{},connection:{options:''}});const [r]=await s.unsafe(${JSON.stringify(BENCHMARK_IDENTITY_SQL)});console.log(JSON.stringify(r));}catch{process.exitCode=1;}finally{await s?.end({timeout:1});}`]));
    benchmarkLoginGuard(this.config, remoteDb);
    need(remoteDb.database === this.config.databaseName && remoteDb.serverVersion === this.config.postgresVersion && remoteDb.serverAddress === this.evidence.databaseServerAddress, 'Pod benchmark credential does not match verified isolated database');
    await this.upload(name, '/data/strfry.conf', (await readFile(config, 'utf8')).replace(contract ? '/usr/local/bin/relay-policy' : '__no_replace__', '/capacity/entrypoint.sh'));
    for (const file of await readdir(directory)) if (['launcher.ts', 'plugin.sh', 'plugin_failure.sh', 'external_timeout.sh', 'calibration.json'].includes(file)) await this.upload(name, '/capacity/' + file, await readFile(join(directory, file), 'utf8'), file.endsWith('.sh'));
    if (contract) {
      await this.upload(name, '/capacity/contract.json', await readFile(contract, 'utf8'));
      // The real launcher reads its file path at startup. The private wrapper
      // sets only this path, never source identity or an admission bypass.
      const record = this.pods.get(name)!;
      await this.upload(name, '/capacity/entrypoint.sh', '#!/bin/sh\nexport MODERATION_CAPACITY_CONTRACT_FILE=/capacity/contract.json\nexec /usr/local/bin/relay-policy\n', true);
      record.config = config;
    }
    await this.upload(name, '/capacity/ready', 'ready\n');
    const f = await this.portForward([...this.args(), 'pod/' + name]); this.pods.get(name)!.forward = f;
    return f.url;
  }
  async logs(name: string) { await this.owned(name); return destinationTimingLog(await this.execute([...this.args(), 'logs', name, '-c', 'relay'])); }
  async restart(name: string) {
    this.pods.get(name)?.forward?.stop();
    const before = await this.owned(name), count = before.status?.containerStatuses?.[0]?.restartCount ?? 0;
    await this.execute([...this.args(), 'exec', name, '-c', 'relay', '--', 'sh', '-c', 'kill -TERM 1']).catch(() => {});
    for (let n = 0; n < 180; n++) { const pod = await this.owned(name); if ((pod.status?.containerStatuses?.[0]?.restartCount ?? 0) > count && pod.status?.containerStatuses?.[0]?.state?.running) { const f = await this.portForward([...this.args(), 'pod/' + name]); this.pods.get(name)!.forward = f; return f.url; } await Bun.sleep(1000); }
    throw new Error('Benchmark container did not restart with retained data');
  }
  async remove(name: string) {
    const pod = await this.owned(name); const record = this.pods.get(name)!; record.forward?.stop();
    // UID precondition prevents a replacement resource from being removed by cleanup.
    await this.execute([...this.args(), 'delete', '--raw', `/api/v1/namespaces/${this.config.namespace}/pods/${name}`, '-f', '-'], JSON.stringify({ apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: pod.metadata.uid } }));
    await this.execute([...this.args(), 'wait', '--for=delete', `pod/${name}`, '--timeout=90s']);
    this.pods.delete(name);
  }
  async close() {
    let failures = 0;
    for (const name of [...this.pods.keys()]) try { await this.remove(name); } catch { failures++; }
    need(failures === 0, 'Some owned benchmark Pods could not be removed; inspect the dedicated namespace');
  }
}
