/** Synthetic, isolated wire check against the pinned strfry build stage. */
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bytesToHex, channelGroupKey, mintCommunity, voiceGroupKey, voiceMediaKey } from '@armada-bridge/concord-core';
import type { ChannelV2 } from '@armada-bridge/concord-core';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import { ConcordClient } from '../../packages/bridge/src/concord/client';
import { RelayPool, type RelayLike } from '../../packages/bridge/src/concord/pool';
import { localIdentity } from '../../packages/bridge/src/concord/signer';

const image = process.env.REPLAY_STRFRY_IMAGE ?? 'bridge-replay-strfry:test';
const directory = await mkdtemp(join(tmpdir(), 'bridge-replay-interop-'));
const containers: string[] = [], pools: RelayPool[] = [];
async function docker(args: string[], input?: string) {
  const child = Bun.spawn(['docker', ...args], { stdin: input === undefined ? 'ignore' : new Blob([input]), stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error(`Docker ${args[0]} failed: ${err}`);
  return (args[0] === 'logs' ? out + err : out).trim();
}
try {
  const pins = await docker(['run', '--rm', image, 'sh', '-c', 'git rev-parse HEAD && git -C external/negentropy rev-parse HEAD']);
  assert.equal(pins, '3fd1bc538e5e4dc2d122041064753be0177748b4\n929c591b6c7a444bd106ee884c760568936dfef8');
  const { community } = mintCommunity('Synthetic replay fixture', getPublicKey(generateSecretKey()), ['wss://relay.example']);
  const id = new Uint8Array(32).fill(7), group = channelGroupKey(community.root, id, 0), stream = { epoch: 0n, group };
  const channel: ChannelV2 = { id, idHex: bytesToHex(id), name: 'synthetic', isPrivate: false, streams: [stream], current: stream,
    voice: { room: voiceGroupKey(community.root, id, 0), mediaKey: voiceMediaKey(community.root, id, 0) } };
  const events: NostrEvent[] = [];
  const capture: RelayLike = { query: async () => [], publish: async e => { events.push(e); }, subscribe: () => () => {}, close: async () => {} };
  const writer = new ConcordClient(community, capture, localIdentity(generateSecretKey())), author = localIdentity(generateSecretKey());
  const at = Math.floor(Date.now() / 1000) - 60;
  for (let i = 0; i < 403; i++) {
    await writer.sendChat(channel, { content: `synthetic replay ${i}`, author, ms: at * 1000 + i });
    events[i] = finalizeEvent({ ...events[i], created_at: at }, group.sk);
  }
  for (const cap of [4, 8, 300, 400, 2]) {
    const name = `bridge-replay-${process.pid}-${cap}`, path = join(directory, `${cap}.conf`);
    await writeFile(path, `db = "/tmp/replay-db/"\nrelay { nofiles = 0 bind = "0.0.0.0" port = 7777 maxFilterLimit = ${cap} negentropy { maxSyncEvents = ${cap === 2 ? 8 : 1000000} } auth { enabled = false } logging { invalidEvents = false } }\n`);
    await docker(['run', '-d', '--name', name, '-p', '127.0.0.1::7777', '-v', `${path}:/tmp/replay.conf:ro`, image, 'sh', '-c', 'mkdir -p /tmp/replay-db && exec /build/strfry --config=/tmp/replay.conf relay']);
    containers.push(name);
    const port = (await docker(['port', name, '7777/tcp'])).split(':').at(-1);
    for (let attempt = 0; ; attempt++) {
      try { await fetch(`http://127.0.0.1:${port}`); break; }
      catch { if (attempt >= 100) throw new Error(`Relay did not start: ${await docker(['logs', name])}`); await Bun.sleep(100); }
    }
    await docker(['exec', '-i', name, '/build/strfry', '--config=/tmp/replay.conf', 'import'], events.map(e => JSON.stringify(e)).join('\n') + '\n');
    const pool = new RelayPool([`ws://127.0.0.1:${port}`]); pools.push(pool);
    assert.equal((await pool.queryStrict([{ kinds: [1059], authors: [group.pk], since: at, until: at, limit: 500 }])).length, cap);
    const client = new ConcordClient(community, pool, localIdentity(generateSecretKey()));
    if (cap === 2) {
      let certified = false;
      await assert.rejects(client.backfillChannel(channel, at, 500, { onWindowComplete: async () => { certified = true; } }), /second exceeds/);
      assert.equal(certified, false);
      console.log('PASS pinned strfry maxSyncEvents=8: NEG-ERR splits and an oversized second remains uncertified');
      await pool.close(); continue;
    }
    const found = new Set<string>(); let certified = 0;
    const result = await client.backfillChannel(channel, at, 500, {
      onBatch: async ({ chats }) => { assert(chats.length <= 100); for (const chat of chats) { found.add(chat.content); assert.equal(chat.sourceWrapCreatedAt, at); } },
      onWindowComplete: async ({ until }) => { certified = until; assert.equal(found.size, 403); },
    });
    assert.equal(found.size, 403); assert.equal(result.certifiedUntil, certified); assert(certified >= at);
    console.log(`PASS pinned strfry cap=${cap}: 403 same-second wraps, inventory+exact-ID fetch+decoded delivery+certified endpoint`);
    await pool.close();
  }
} finally {
  await Promise.allSettled(pools.map(pool => pool.close()));
  for (const name of containers) await docker(['rm', '-f', name]);
  await rm(directory, { recursive: true, force: true });
}
