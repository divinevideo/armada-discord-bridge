/**
 * Read-only retained-history inspection; decoded candidates are not Discord posts.
 * PORTAL_SEAL_KEY=... DATABASE_URL=... bun run scripts/probe-backlog.ts <bridge-id> [...]
 * Emits bounded JSON reports without content, invite material or source errors.
 */
import postgres from 'postgres';
import { generateSecretKey } from 'nostr-tools/pure';
import { KIND_DELETE, KIND_REACTION, KIND_TYPING, STOCK_RELAYS, parseInviteLink } from '@armada-bridge/concord-core';
import type { ChannelV2 } from '@armada-bridge/concord-core';
import { ConcordClient, resolveInvite } from '../packages/bridge/src/concord/client';
import { RelayPool } from '../packages/bridge/src/concord/pool';
import { localIdentity } from '../packages/bridge/src/concord/signer';
import type { ReplayOptions, ReplayResult } from '../packages/bridge/src/concord/replay';
import type { ChannelLink } from '../packages/bridge/src/router';
import type { DeliverySnapshot } from '../packages/bridge/src/db/deliveryState';
import { deliveryScope } from '../packages/bridge/src/db/deliveryState';
import { PostgresMappingStore } from '../packages/bridge/src/db/store';
import type { BridgeRow } from '../packages/portal/src/manager';
import { deliveryRelays } from '../packages/portal/src/relayGuard';
import { unseal } from '../packages/portal/src/seal';

export interface ProbeState {
  snapshot?: DeliverySnapshot;
  upgrade: 'eligible' | 'consumed' | 'none';
  legacyCheckpoint?: number;
}

/** No worker attachment, eligibility consumption, queue reads that expire rows,
 * or checkpoint writes are needed to inspect a link. Enforce this in Postgres. */
export async function readProbeState(sql: postgres.Sql, tenant: string, link: ChannelLink, owner: string): Promise<ProbeState> {
  return sql.begin('isolation level repeatable read read only', async tx => {
    const snapshot = await new PostgresMappingStore(sql, tenant).inspectDelivery(link, tx);
    const [upgrade] = await tx`SELECT consumed FROM channel_delivery_upgrade_eligibility
      WHERE ${deliveryScope(tx, tenant, link)} AND owner_id=${owner}`;
    const [checkpoint] = await tx`SELECT last_seen_at FROM channel_delivery_checkpoints
      WHERE ${deliveryScope(tx, tenant, link)}`;
    return { snapshot, upgrade: upgrade ? (upgrade.consumed ? 'consumed' : 'eligible') : 'none',
      ...(checkpoint ? { legacyCheckpoint: Number(checkpoint.last_seen_at) } : {}) };
  }) as Promise<ProbeState>;
}

export function secondsIso(seconds: number | undefined): string | undefined {
  return seconds === undefined ? undefined : new Date(seconds * 1000).toISOString();
}

/** This is a replacement-attachment inspection. An armed uncertainty marker
 * forces enumeration from zero; it does not erase lifecycle applicability. */
export function probeFloor(snapshot: DeliverySnapshot, streams: string[]): number {
  if (snapshot.workerUncertain) return 0;
  const tail = snapshot.repairFloor ?? Math.max(0, (snapshot.certifiedUntil ?? snapshot.activationFloor) - 60);
  const missing = streams.filter(pk => snapshot.coverage[pk] === undefined);
  const introductions = missing.length ? [snapshot.recoveryFloor, ...missing.flatMap(pk => snapshot.legacyBoundaries[pk] === undefined ? [] : [snapshot.legacyBoundaries[pk]])]
    .map(at => snapshot.repairFloor === undefined ? Math.max(0, at - 60) : at) : [];
  return Math.min(tail, ...introductions);
}

export const PROBE_LIMITS = { candidates: 65_536, windows: 4096, durationMs: 60_000 } as const;
class ProbeBudgetError extends Error {}
type ProbeReason = 'candidate_budget' | 'window_budget' | 'deadline_or_abort' | 'replay_unavailable';
export interface ProbeScan {
  scanFloor: number;
  scanUpper: number;
  scanComplete: boolean;
  completedWindows: number;
  observedCertifiedUntil?: number;
  incompleteReason?: ProbeReason;
  decodedCandidates: number;
  decodedCandidatesByKind: { message: number; deletion: number; reaction: number; typing: number; other: number };
}
type Replay = (channel: ChannelV2, since: number, limit: number, options: ReplayOptions) => Promise<ReplayResult>;

/** Count only: no router, mapping lookup, dedupe prediction or durable mutation.
 * Replay itself bounds each inventory/decode window; callbacks retain counters. */
export async function scanCandidates(channel: ChannelV2, floor: number, replay: Replay,
  options: { signal?: AbortSignal; maxCandidates?: number; maxWindows?: number; durationMs?: number } = {}): Promise<ProbeScan> {
  const maxCandidates = options.maxCandidates ?? PROBE_LIMITS.candidates;
  const maxWindows = options.maxWindows ?? PROBE_LIMITS.windows;
  const signal = AbortSignal.any([AbortSignal.timeout(options.durationMs ?? PROBE_LIMITS.durationMs), ...(options.signal ? [options.signal] : [])]);
  const result: ProbeScan = { scanFloor: floor, scanUpper: Math.max(0, Math.floor(Date.now() / 1000) - 60), scanComplete: false,
    completedWindows: 0, decodedCandidates: 0, decodedCandidatesByKind: { message: 0, deletion: 0, reaction: 0, typing: 0, other: 0 } };
  let budget: ProbeReason | undefined;
  try {
    await replay(channel, floor, 100, {
      signal,
      onBatch: async ({ chats }, context) => {
        signal.throwIfAborted(); context.signal.throwIfAborted();
        for (const chat of chats) {
          if (result.decodedCandidates >= maxCandidates) { budget = 'candidate_budget'; throw new ProbeBudgetError(); }
          const kind = chat.kind === 9 ? 'message' : chat.kind === KIND_DELETE ? 'deletion' : chat.kind === KIND_REACTION ? 'reaction' : chat.kind === KIND_TYPING ? 'typing' : 'other';
          result.decodedCandidatesByKind[kind]++;
          result.decodedCandidates++;
        }
      },
      onWindowComplete: async (window, context) => {
        signal.throwIfAborted(); context.signal.throwIfAborted();
        if (result.completedWindows >= maxWindows) { budget = 'window_budget'; throw new ProbeBudgetError(); }
        result.completedWindows++;
        result.observedCertifiedUntil = window.until;
        result.scanUpper = window.runUntil;
      },
    });
    signal.throwIfAborted();
    result.scanComplete = floor > result.scanUpper || result.observedCertifiedUntil === result.scanUpper;
    if (!result.scanComplete) result.incompleteReason = 'replay_unavailable';
  } catch {
    // Source errors may contain opaque payloads/identifiers. No text or name
    // from the exception belongs in this operator report.
    result.incompleteReason = budget ?? (signal.aborted ? 'deadline_or_abort' : 'replay_unavailable');
  }
  return result;
}

type ProbeRow = Pick<BridgeRow, 'bridge_id' | 'status' | 'invite_url_sealed' | 'community_id' | 'concord_channel_id' | 'discord_guild_id' | 'discord_channel_id'> & { tenant_id: string };

export async function runProbeCli(ids = process.argv.slice(2)): Promise<void> {
  if (!ids.length || ids.length > 64 || ids.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) {
    console.error('probe: usage: probe-backlog.ts <bridge-uuid> [...] (maximum 64)'); process.exitCode = 1; return;
  }
  const sealKey = process.env.PORTAL_SEAL_KEY, database = process.env.DATABASE_URL;
  if (!sealKey || !database) { console.error('probe: missing_configuration'); process.exitCode = 1; return; }
  const sql = postgres(database, { max: 1, connect_timeout: 5, onnotice() {},
    connection: { default_transaction_read_only: true, statement_timeout: 15000 } });
  try {
    // Sequential reports bound pools and memory independently of requested IDs.
    for (const id of ids) {
      let stage = 'state_unavailable';
      let bootstrap: RelayPool | undefined, pool: RelayPool | undefined;
      try {
        const [row] = await sql<ProbeRow[]>`SELECT bridge_id,tenant_id,status,invite_url_sealed,community_id,
          concord_channel_id,discord_guild_id,discord_channel_id FROM bridges WHERE bridge_id::text=${id}`;
        if (!row) { console.log(JSON.stringify({ bridgeId: id, state: 'not_found' })); continue; }
        if (!row.community_id || !row.concord_channel_id || !row.discord_guild_id || !row.discord_channel_id) {
          console.log(JSON.stringify({ bridgeId: id, state: 'activation_required', bridgeStatus: row.status })); continue;
        }
        const link: ChannelLink = { communityId: row.community_id, concordChannelIdHex: row.concord_channel_id,
          discordGuildId: row.discord_guild_id, discordChannelId: row.discord_channel_id, enabled: row.status === 'active' };
        const state = await readProbeState(sql, row.tenant_id, link, id), s = state.snapshot;
        const metadata = { bridgeId: id, bridgeStatus: row.status, upgrade: state.upgrade,
          legacyCheckpoint: state.legacyCheckpoint, legacyCheckpointIso: secondsIso(state.legacyCheckpoint),
          persistedCertifiedUntil: s?.certifiedUntil, persistedCertifiedUntilIso: secondsIso(s?.certifiedUntil),
          persistedRepairFloor: s?.repairFloor, deletionApplicabilityFloor: s?.deletionFloor,
          workerUncertain: s?.workerUncertain };
        if (!s || !s.active || s.ownerId !== id) {
          console.log(JSON.stringify({ ...metadata, state: !s ? (state.upgrade === 'eligible' ? 'upgrade_pending_unknown_history' : 'activation_required_unknown_history') : 'inactive_or_replaced' })); continue;
        }
        if (!row.invite_url_sealed) throw new Error();
        stage = 'invite_unavailable';
        const inviteUrl = unseal(sealKey, row.invite_url_sealed), invite = parseInviteLink(inviteUrl);
        if (!invite) throw new Error();
        // Discovery and delivery are distinct. Neither silently drops a source.
        stage = 'bootstrap_relays_rejected';
        bootstrap = new RelayPool(await deliveryRelays(invite.bootstrapRelays, STOCK_RELAYS));
        stage = 'invite_unavailable';
        const { community } = await resolveInvite(inviteUrl, bootstrap);
        if (community.idHex !== link.communityId) { stage = 'community_scope_mismatch'; throw new Error(); }
        stage = 'delivery_relays_rejected';
        const relays = await deliveryRelays(community.relays, STOCK_RELAYS);
        pool = new RelayPool(relays);
        stage = 'control_unavailable';
        const client = new ConcordClient(community, pool, localIdentity(generateSecretKey()));
        await client.syncControl({ signal: AbortSignal.timeout(PROBE_LIMITS.durationMs) });
        const channel = client.channel(link.concordChannelIdHex);
        if (!channel) { stage = 'channel_unavailable'; throw new Error(); }
        const scan = await scanCandidates(channel, probeFloor(s, channel.streams.map(stream => stream.group.pk)), client.backfillChannel.bind(client));
        console.log(JSON.stringify({ ...metadata, state: s.suspended ? 'suspended' : 'active', configuredRelayCount: relays.length,
          ...scan, scanFloorIso: secondsIso(scan.scanFloor), observedCertifiedUntilIso: secondsIso(scan.observedCertifiedUntil),
          interpretation: 'decoded_candidates_only_not_discord_post_predictions' }));
      } catch {
        console.log(JSON.stringify({ bridgeId: id, state: 'unavailable', reason: stage }));
        process.exitCode = 1;
      } finally {
        await Promise.allSettled([bootstrap?.close(), pool?.close()]);
      }
    }
  } finally { await sql.end({ timeout: 5 }); }
}

if (import.meta.main) {
  try { await runProbeCli(); }
  catch { console.error('probe: unavailable'); process.exitCode = 1; }
}
