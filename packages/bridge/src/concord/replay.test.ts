import { expect, test } from 'bun:test';
import { bytesToHex, channelGroupKey, mintCommunity, voiceGroupKey, voiceMediaKey } from '@armada-bridge/concord-core';
import type { ChannelV2 } from '@armada-bridge/concord-core';
import type { NostrEvent } from '@nostrify/nostrify';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { RelayLike } from './pool';
import { replayChannel } from './replay';
import { ReplayWindowLimitError } from './reconciliation';

const { community } = mintCommunity('Synthetic replay limits', getPublicKey(generateSecretKey()), ['wss://relay.example']);
const id = new Uint8Array(32).fill(9), group = channelGroupKey(community.root, id, 0), stream = { epoch: 0n, group };
const channel: ChannelV2 = { id, idHex: bytesToHex(id), name: 'synthetic', isPrivate: false, streams: [stream], current: stream,
  voice: { room: voiceGroupKey(community.root, id, 0), mediaKey: voiceMediaKey(community.root, id, 0) } };
const eventId = (n: number) => n.toString(16).padStart(64, '0');
function carrier(n: number, at: number): NostrEvent {
  // The replay source is already signature-verified; an undecodable payload is
  // still part of the inventory and must be fetched before certification.
  return { id: eventId(n), pubkey: group.pk, kind: 1059, tags: [], content: 'invalid encrypted payload', created_at: at, sig: '00'.repeat(64) };
}
function pool(events: Record<string, NostrEvent[]>, caps: Record<string, number> = {}): RelayLike {
  return {
    replayRelays: Object.keys(events),
    query: async () => { throw new Error('uncertified fallback used'); },
    enumerateRelay: async (url, f) => events[url].filter(e => (f.since === undefined || e.created_at >= f.since) && (f.until === undefined || e.created_at <= f.until)).map(e => e.id),
    fetchRelay: async (url, ids) => events[url].filter(e => ids.includes(e.id)).slice(0, caps[url] ?? Infinity),
    publish: async () => {}, subscribe: () => () => {}, close: async () => {},
  };
}

test('empty windows certify the frozen run-start endpoint, without inventing a newest event', async () => {
  const start = Math.floor(Date.now() / 1000), p = pool({ a: [] }), windows: Array<[number, number]> = [];
  const result = await replayChannel(p, channel, start - 600, 500, { onWindowComplete: async w => { windows.push([w.until, w.runUntil]); } });
  expect(windows).toEqual([[start - 301, start], [start - 1, start], [start, start]]);
  expect(result.certifiedUntil).toBe(start); expect(result.newestWrapAt).toBeUndefined();
});
test('different relay subsets and caps each have their outstanding IDs fetched before coverage', async () => {
  const at = Math.floor(Date.now() / 1000), all = Array.from({ length: 20 }, (_, i) => carrier(i + 1, at));
  const p = pool({ a: all.slice(0, 15), b: all.slice(5) }, { a: 4, b: 8 });
  const fetched = { a: new Set<string>(), b: new Set<string>() }, fetch = p.fetchRelay!;
  p.fetchRelay = async (url, ids, filter, opts) => { const events = await fetch(url, ids, filter, opts); events.forEach(e => fetched[url as 'a' | 'b'].add(e.id)); return events; };
  const result = await replayChannel(p, channel, at);
  expect(fetched.a.size).toBe(15); expect(fetched.b.size).toBe(15); expect(result.certifiedUntil).toBe(at);
});
test('another relay holding an ID cannot certify the source that still advertises but omits it', async () => {
  const at = Math.floor(Date.now() / 1000), event = carrier(1, at), p = pool({ a: [event], b: [event] });
  const fetch = p.fetchRelay!; p.fetchRelay = (url, ...args) => url === 'b' ? Promise.resolve([]) : fetch(url, ...args);
  const windows: number[] = [];
  await expect(replayChannel(p, channel, at, 500, { onWindowComplete: async w => { windows.push(w.until); } })).rejects.toThrow('unavailable IDs');
  expect(windows).toEqual([]);
});
test('a purged carrier is reconciled once and new inventory IDs are fetched before certification', async () => {
  const at = Math.floor(Date.now() / 1000), missing = carrier(1, at), replacement = carrier(2, at), events = { a: [missing] }, p = pool(events);
  const fetch = p.fetchRelay!; let fetched = '';
  p.fetchRelay = async (url, ids, filter, opts) => {
    if (ids.includes(missing.id)) { events.a = [replacement]; return []; }
    fetched = ids[0]; return fetch(url, ids, filter, opts);
  };
  const result = await replayChannel(p, channel, at);
  expect(fetched).toBe(replacement.id); expect(result.certifiedUntil).toBe(at);
});
test('inventory resource limits split oldest first and pin an oversized second', async () => {
  const at = Math.floor(Date.now() / 1000), p = pool({ a: [] }), windows: Array<[number, number, number]> = [];
  p.enumerateRelay = async (_url, filter) => { if (filter.since! < filter.until!) throw new ReplayWindowLimitError('sync limit'); return []; };
  await replayChannel(p, channel, at - 2, 500, { onWindowComplete: async w => { windows.push([w.since, w.until, w.runUntil]); } });
  expect(windows).toEqual([[at - 2, at - 2, at], [at - 1, at - 1, at], [at, at, at]]);
  p.enumerateRelay = async () => { throw new ReplayWindowLimitError('sync limit'); };
  await expect(replayChannel(p, channel, at)).rejects.toThrow('second exceeds');
});
test('a union larger than 16384 IDs remains incomplete even when each relay is below the limit', async () => {
  const at = Math.floor(Date.now() / 1000), p = pool({ a: [], b: [] }); let fetched = false;
  p.enumerateRelay = async url => Array.from({ length: url === 'a' ? 8192 : 8193 }, (_, i) => eventId(i + (url === 'a' ? 1 : 8193)));
  p.fetchRelay = async () => { fetched = true; return []; };
  await expect(replayChannel(p, channel, at)).rejects.toThrow('second exceeds'); expect(fetched).toBe(false);
});
test('unavailable or unsupported inventories never fall back to queryStrict', async () => {
  const at = Math.floor(Date.now() / 1000), p = pool({ a: [], b: [] });
  p.enumerateRelay = async url => { if (url === 'b') throw new Error('unavailable source'); return []; };
  await expect(replayChannel(p, channel, at)).rejects.toThrow('unavailable source');
  delete p.enumerateRelay;
  await expect(replayChannel(p, channel, at)).rejects.toThrow('does not support certified');
});
