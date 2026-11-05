import { expect, test } from 'bun:test';
import { nip77 } from 'nostr-tools';
import { registerStreamKeys } from '@armada-bridge/concord-core';
import { getPublicKey } from 'nostr-tools/pure';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import type { NostrEvent, NostrFilter } from '@nostrify/nostrify';
import { RelayPool } from './pool';

export function inventoryServer(events: NostrEvent[], opts: { cap?: number; failure?: string; silent?: boolean; disconnect?: boolean; payload?: string } = {}) {
  const frames: any[][] = [];
  const sessions = new Map<string, InstanceType<typeof nip77.Negentropy>>();
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch(request, server) { if (server.upgrade(request)) return; return new Response('no'); },
    websocket: { message(ws, value) {
      const frame = JSON.parse(String(value)); frames.push(frame);
      const [kind, id] = frame;
      if (kind === 'NEG-CLOSE') { sessions.delete(id); return; }
      if (kind === 'NEG-OPEN' || kind === 'NEG-MSG') {
        if (opts.disconnect) { ws.close(); return; }
        if (opts.silent) return;
        if (opts.payload) { ws.send(JSON.stringify(['NEG-MSG', id, opts.payload])); return; }
        if (opts.failure) { ws.send(JSON.stringify([opts.failure, id, 'synthetic failure'])); return; }
        if (kind === 'NEG-OPEN') {
          const filter = frame[2] as NostrFilter;
          const storage = new nip77.NegentropyStorageVector();
          for (const e of events.filter(e => matches(filter, e))) storage.insert(e.created_at, e.id);
          storage.seal(); sessions.set(id, new nip77.Negentropy(storage, 4096));
        }
        const response = kind === 'NEG-OPEN' ? sessions.get(id)!.initiate() : sessions.get(id)!.reconcile(frame[2]);
        ws.send(JSON.stringify(['NEG-MSG', id, response ?? '61']));
      }
      if (kind === 'REQ') {
        for (const e of events.filter(e => matches(frame[2], e)).slice(0, opts.cap ?? Infinity)) ws.send(JSON.stringify(['EVENT', id, e]));
        ws.send(JSON.stringify(['EOSE', id]));
      }
    } },
  });
  return { server, frames, sessions, url: `ws://127.0.0.1:${server.port}` };
}
function matches(f: NostrFilter, e: NostrEvent) {
  return (!f.ids || f.ids.includes(e.id)) && (!f.authors || f.authors.includes(e.pubkey)) &&
    (!f.kinds || f.kinds.includes(e.kind)) && (f.since === undefined || e.created_at >= f.since) && (f.until === undefined || e.created_at <= f.until);
}
function events(count: number) {
  const sk = generateSecretKey();
  return Array.from({ length: count }, (_, i) => finalizeEvent({ kind: 1059, tags: [], content: `synthetic ${i}`, created_at: 100 }, sk));
}

test('inventory enumerates every same-second ID independently of a lower REQ cap', async () => {
  const all = events(20), relay = inventoryServer(all, { cap: 4 }), pool = new RelayPool([relay.url]);
  try {
    const ids = await pool.enumerateRelay(relay.url, { kinds: [1059], since: 100, until: 100 });
    expect(new Set(ids)).toEqual(new Set(all.map(e => e.id)));
    const remaining = new Set(ids), received = new Set<string>();
    while (remaining.size) {
      for (const e of await pool.fetchRelay(relay.url, [...remaining], { kinds: [1059], since: 100, until: 100 })) { remaining.delete(e.id); received.add(e.id); }
    }
    expect(received.size).toBe(20);
    expect(relay.frames.filter(f => f[0] === 'NEG-OPEN').every(f => !('limit' in f[2]))).toBe(true);
    await Bun.sleep(5); expect(relay.sessions.size).toBe(0);
  } finally { await pool.close(); relay.server.stop(true); }
});
for (const failure of ['NEG-ERR', 'NEG-CLOSE', 'CLOSED']) test(`${failure} cannot masquerade as inventory completion`, async () => {
  const relay = inventoryServer([], { failure }), pool = new RelayPool([relay.url]);
  try { await expect(pool.enumerateRelay(relay.url, { kinds: [1059] })).rejects.toThrow(); }
  finally { await pool.close(); relay.server.stop(true); }
});
for (const opts of [{ silent: true }, { disconnect: true }]) test(`inventory fails on ${opts.silent ? 'timeout' : 'disconnect'} and closes its session`, async () => {
  const relay = inventoryServer([], opts), pool = new RelayPool([relay.url]);
  try { await expect(pool.enumerateRelay(relay.url, {}, { signal: AbortSignal.timeout(50) })).rejects.toThrow(); }
  finally { await pool.close(); relay.server.stop(true); }
});

test('exact-ID fetch rejects an oversized encrypted event frame', async () => {
  const event = finalizeEvent({ kind: 1059, tags: [], content: 'x'.repeat(2 * 1024 * 1024), created_at: 100 }, generateSecretKey());
  const relay = inventoryServer([event]), pool = new RelayPool([relay.url]);
  try { await expect(pool.fetchRelay(relay.url, [event.id], { kinds: [1059] })).rejects.toThrow(); }
  finally { await pool.close(); relay.server.stop(true); }
});

for (const [label, payload] of [
  ['unsupported version', '62'], ['malformed frame', 'not-hex'],
  ['oversized frame', '61' + '00'.repeat(70_000)],
  ['no-progress exchange', '61000001' + '00'.repeat(16)],
]) test(`inventory rejects ${label} and cleans up its session`, async () => {
  const relay = inventoryServer([], { payload }), pool = new RelayPool([relay.url]);
  try {
    await expect(pool.enumerateRelay(relay.url, {})).rejects.toThrow();
    await Bun.sleep(5);
    expect(relay.frames.filter(f => f[0] === 'NEG-CLOSE')).toHaveLength(1);
  } finally { await pool.close(); relay.server.stop(true); }
});

test('inventory authenticates wanted stream keys and reauthenticates after a disconnect', async () => {
  const sk = generateSecretKey(), pk = getPublicKey(sk), authBySocket = new Map<unknown, Set<string>>();
  let disconnectOnce = true, authenticatedSockets = 0;
  const storage = new nip77.NegentropyStorageVector(); storage.seal();
  const empty = new nip77.Negentropy(storage).initiate();
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch(request, server) { if (server.upgrade(request)) return; return new Response('no'); },
    websocket: {
      open(ws) { authBySocket.set(ws, new Set()); ws.send(JSON.stringify(['AUTH', 'synthetic-challenge'])); },
      message(ws, value) {
        const frame = JSON.parse(String(value)), authenticated = authBySocket.get(ws)!;
        if (frame[0] === 'AUTH') {
          authenticated.add(frame[1].pubkey); ws.send(JSON.stringify(['OK', frame[1].id, true, '']));
        }
        if (frame[0] === 'NEG-OPEN') {
          if (!authenticated.has(pk)) { ws.send(JSON.stringify(['NEG-ERR', frame[1], 'auth-required: stream'])); return; }
          authenticatedSockets++;
          if (disconnectOnce) { disconnectOnce = false; ws.close(); return; }
          ws.send(JSON.stringify(['NEG-MSG', frame[1], empty]));
        }
      },
    },
  });
  const url = `ws://127.0.0.1:${server.port}`;
  registerStreamKeys([{ pk, sk, convKey: new Uint8Array(32) }], [url]);
  const pool = new RelayPool([url]);
  try {
    await expect(pool.enumerateRelay(url, { authors: [pk] }, { signal: AbortSignal.timeout(2000) })).rejects.toThrow('disconnected');
    expect(await pool.enumerateRelay(url, { authors: [pk] }, { signal: AbortSignal.timeout(3000) })).toEqual([]);
    expect(authenticatedSockets).toBe(2);
  } finally { await pool.close(); server.stop(true); }
}, 6000);

test('exact-ID fetch does not accept changed content under an advertised signed ID', async () => {
  const signed = events(1)[0], relay = inventoryServer([{ ...signed, content: 'changed after signing' }]), pool = new RelayPool([relay.url]);
  try { await expect(pool.fetchRelay(relay.url, [signed.id], { kinds: [1059] })).rejects.toThrow('Invalid event'); }
  finally { await pool.close(); relay.server.stop(true); }
});

test('exact-ID fetch returns bounded progress when a batch exceeds its encrypted byte budget', async () => {
  const sk = generateSecretKey();
  const all = Array.from({ length: 100 }, (_, i) => finalizeEvent({ kind: 1059, tags: [], content: `${i}:` + 'x'.repeat(100_000), created_at: 100 }, sk));
  const relay = inventoryServer(all), pool = new RelayPool([relay.url]);
  try {
    const first = await pool.fetchRelay(relay.url, all.map(e => e.id), { kinds: [1059] });
    expect(first.length).toBeGreaterThan(0); expect(first.length).toBeLessThan(100);
    const remaining = all.filter(e => !first.some(f => f.id === e.id));
    const second = await pool.fetchRelay(relay.url, remaining.map(e => e.id), { kinds: [1059] });
    expect(new Set([...first, ...second].map(e => e.id)).size).toBe(100);
  } finally { await pool.close(); relay.server.stop(true); }
});
