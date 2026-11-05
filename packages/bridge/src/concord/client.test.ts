import { describe, expect, it } from "bun:test";
import {
  KIND_BOT_MANIFEST,
  KIND_JOIN_LEAVE,
  KIND_MESSAGE,
  KIND_TYPING,
  KIND_WRAP_EPHEMERAL,
  STOCK_RELAYS,
  buildBundleEvent,
  buildChannelEdition,
  buildInviteUrl,
  bytesToHex,
  channelGroupKey,
  currentControlWriteGroup,
  sealEdition,
  guestbookGroups,
  mintCommunity,
  mintLinkSigner,
  mintToken,
  openGuestbookWraps,
  openWrap,
  voiceGroupKey,
  voiceMediaKey,
} from "@armada-bridge/concord-core";
import type { ChannelV2, InviteBundle } from "@armada-bridge/concord-core";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { NostrEvent } from "nostr-tools/pure";
import type { NostrFilter } from "@nostrify/nostrify";

import { deliverConcordChat } from "./delivery";
import { CONTROL_REFOLD_MS, ConcordClient, hasProxyTag, proxyTag, resolveInvite } from "./client";
import type { RelayLike } from "./pool";
import { localIdentity } from "./signer";

/** In-memory pool: canned query results, captured publishes, manual emit. */
class FakePool implements RelayLike {
  published: NostrEvent[] = [];
  private subs: Array<{ filters: NostrFilter[]; onEvent: (e: NostrEvent) => void }> = [];
  constructor(private readonly canned: NostrEvent[] = [], private readonly cap = Infinity) {}
  readonly replayRelays = ["fake"];
  async enumerateRelay(_url: string, filter: NostrFilter): Promise<string[]> {
    return this.canned.filter(e => matches([filter], e) && (filter.since === undefined || e.created_at >= filter.since) && (filter.until === undefined || e.created_at <= filter.until)).map(e => e.id);
  }
  async fetchRelay(_url: string, ids: string[]): Promise<NostrEvent[]> { return this.canned.filter(e => ids.includes(e.id)).slice(0, this.cap); }
  async query(filters: NostrFilter[]): Promise<NostrEvent[]> {
    const found = new Map<string, NostrEvent>();
    for (const filter of filters) for (const event of this.canned.filter(event => matches([filter], event) &&
      (filter.since === undefined || event.created_at >= filter.since) &&
      (filter.until === undefined || event.created_at <= filter.until))
      .sort((a, b) => b.created_at - a.created_at).slice(0, Math.min(filter.limit ?? Infinity, this.cap))) found.set(event.id, event);
    return [...found.values()];
  }
  async publish(event: NostrEvent): Promise<void> {
    this.published.push(event);
  }
  subscribe(filters: NostrFilter[], handlers: { onEvent: (e: NostrEvent) => void }): () => void {
    const sub = { filters, onEvent: handlers.onEvent };
    this.subs.push(sub);
    return () => {
      this.subs = this.subs.filter((s) => s !== sub);
    };
  }
  /** Push an event into every matching live subscription. */
  emit(event: NostrEvent): void {
    for (const sub of this.subs) {
      if (matches(sub.filters, event)) sub.onEvent(event);
    }
  }
  async close(): Promise<void> {}
}

function matches(filters: NostrFilter[], event: NostrEvent): boolean {
  return filters.some(
    (f) =>
      (!f.kinds || f.kinds.includes(event.kind)) &&
      (!f.authors || f.authors.includes(event.pubkey)),
  );
}

function makeCommunity() {
  const ownerSk = generateSecretKey();
  const { community } = mintCommunity("Bridge Test", getPublicKey(ownerSk), ["wss://relay.example"]);
  return { community, ownerSk };
}

function makeCommunity2(ownerSk: Uint8Array) {
  const { community } = mintCommunity("Bridge Test", getPublicKey(ownerSk), ["wss://relay.example"]);
  return { community };
}

function makeChannel(community: { root: Uint8Array }): ChannelV2 {
  const channelId = new Uint8Array(32).fill(7);
  const group = channelGroupKey(community.root, channelId, 0);
  const stream = { epoch: 0n, group };
  return {
    id: channelId,
    idHex: bytesToHex(channelId),
    name: "general",
    isPrivate: false,
    voice: { room: voiceGroupKey(community.root, channelId, 0), mediaKey: voiceMediaKey(community.root, channelId, 0) },
    streams: [stream],
    current: stream,
  };
}

describe("resolveInvite", () => {
  it("fetches, decrypts, and rehydrates a community from an invite URL", async () => {
    const { community } = makeCommunity();
    const bundle: InviteBundle = {
      community_id: community.idHex,
      owner: community.owner,
      owner_salt: bytesToHex(community.ownerSalt),
      community_root: bytesToHex(community.root),
      root_epoch: 0,
      channels: [],
      relays: community.relays,
      name: community.name,
    };
    const linkSigner = mintLinkSigner();
    const token = mintToken();
    const event = buildBundleEvent(bundle, token, linkSigner.sk);
    const url = buildInviteUrl("https://armada.example", linkSigner.pk, token, [STOCK_RELAYS[0]]);

    const result = await resolveInvite(url, new FakePool([event]));
    expect(result.community.idHex).toBe(community.idHex);
    expect(result.community.owner).toBe(community.owner);
    expect(result.entry.invite_ref).toBeDefined();
  });

  it("rejects a tampered bundle (wrong signer)", async () => {
    const { community } = makeCommunity();
    const bundle: InviteBundle = {
      community_id: community.idHex,
      owner: community.owner,
      owner_salt: bytesToHex(community.ownerSalt),
      community_root: bytesToHex(community.root),
      root_epoch: 0,
      channels: [],
      relays: community.relays,
      name: community.name,
    };
    const linkSigner = mintLinkSigner();
    const imposter = mintLinkSigner();
    const token = mintToken();
    // Bundle published by an imposter key; the URL names the real signer.
    const event = buildBundleEvent(bundle, token, imposter.sk);
    const url = buildInviteUrl("https://armada.example", linkSigner.pk, token, [STOCK_RELAYS[0]]);
    await expect(resolveInvite(url, new FakePool([event]))).rejects.toThrow();
  });
});

describe("ConcordClient", () => {
  it("publishes a guestbook join that opens under the guestbook group", async () => {
    const { community } = makeCommunity();
    const pool = new FakePool();
    const primary = localIdentity(generateSecretKey());
    const client = new ConcordClient(community, pool, primary);

    await client.publishJoin();
    expect(pool.published).toHaveLength(1);

    const opened = openGuestbookWraps(pool.published, guestbookGroups(community));
    expect(opened).toHaveLength(1);
    expect(opened[0].kind).toBe(KIND_JOIN_LEAVE);
    expect(opened[0].author).toBe(primary.pk);
  });

  it("sends a chat rumor that round-trips through openWrap with binding tags", async () => {
    const { community } = makeCommunity();
    const channel = makeChannel(community);
    const pool = new FakePool();
    const primary = localIdentity(generateSecretKey());
    const puppet = localIdentity(generateSecretKey());
    const client = new ConcordClient(community, pool, primary);

    const { rumor, wrap } = await client.sendChat(channel, {
      content: "hello from discord",
      author: puppet,
      tags: [proxyTag("111", "222", "1234567890")],
    });

    expect(pool.published).toHaveLength(1);
    const opened = openWrap(wrap, channel.current.group);
    expect(opened.rumorId).toBe(rumor.id);
    expect(opened.kind).toBe(KIND_MESSAGE);
    expect(opened.author).toBe(puppet.pk);
    expect(opened.content).toBe("hello from discord");
    expect(opened.tags).toContainEqual(["channel", channel.idHex]);
    expect(hasProxyTag(opened)).toBe(true);
  });

  it("streams live channel chat once per rumor, deduping wrap re-delivery", async () => {
    const { community } = makeCommunity();
    const channel = makeChannel(community);
    const pool = new FakePool();
    const client = new ConcordClient(community, pool, localIdentity(generateSecretKey()));
    const puppet = localIdentity(generateSecretKey());

    const seen: string[] = [];
    client.subscribeChannel(channel, (chat) => seen.push(`${chat.kind}:${chat.content}`));

    const { wrap } = await client.sendChat(channel, { content: "live one", author: puppet });
    pool.emit(wrap);
    pool.emit(wrap); // relay re-delivery must not duplicate
    await new Promise((r) => setTimeout(r, 20));

    expect(seen).toEqual(["9:live one"]);
  });

  it("live-folds a channel edition from the owner into channelsView", async () => {
    const ownerSk = generateSecretKey();
    const { community } = makeCommunity2(ownerSk);
    const pool = new FakePool();
    // The bridge is a plain member: it holds the Control Plane's ADDRESS and
    // the community_root-derived read key, never the staff `control_root`
    // (CORD-02 §2). Dropping the secret here is what makes this a real test of
    // the split — a member reading a plane only staff can write.
    const memberView = { ...community, controlRoot: undefined };
    const client = new ConcordClient(memberView, pool, localIdentity(generateSecretKey()));

    let folds = 0;
    const unsubscribe = client.subscribeControl(() => folds++);

    const owner = localIdentity(ownerSk);
    const channelId = new Uint8Array(32).fill(9);
    const otherId = new Uint8Array(32).fill(10);
    for (const [id, name] of [[channelId, "bridged"], [otherId, "other"]] as const) {
      const edition = buildChannelEdition(id, { name, private: false }, {
        actorPubkey: owner.pk,
        version: 1n,
      });
      pool.emit(await sealEdition(edition, currentControlWriteGroup(community), owner.signer));
    }

    // A replayed plane arrives as a burst; it folds once, not once per wrap.
    expect(folds).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, CONTROL_REFOLD_MS + 50));
    unsubscribe();
    expect(folds).toBe(1);
    const names = client.channels().map((c) => c.name);
    expect(names).toContain("bridged");
    expect(names).toContain("other");
    expect(client.channel(bytesToHex(channelId))).toBeDefined();
  });

  it("refuses to publish for a banned puppet", async () => {
    const { community } = makeCommunity();
    const channel = makeChannel(community);
    const puppet = localIdentity(generateSecretKey());
    const client = new ConcordClient(community, new FakePool(), localIdentity(generateSecretKey()));
    client.folded = { banned: new Set([puppet.pk]) } as unknown as typeof client.folded;

    await expect(
      client.sendChat(channel, { content: "nope", author: puppet }),
    ).rejects.toThrow(/banned/);
  });
});

describe("ConcordClient: puppet joins, typing, manifest, backfill", () => {
  it("publishes a guestbook join for a puppet identity", async () => {
    const { community } = makeCommunity();
    const pool = new FakePool();
    const client = new ConcordClient(community, pool, localIdentity(generateSecretKey()));
    const puppet = localIdentity(generateSecretKey());

    await client.publishJoin(Date.now(), puppet);
    const [join] = openGuestbookWraps(pool.published, guestbookGroups(community));
    expect(join.kind).toBe(KIND_JOIN_LEAVE);
    expect(join.author).toBe(puppet.pk);
  });

  it("sendTyping publishes an ephemeral 21059 wrap with a bound 23311 rumor", async () => {
    const { community } = makeCommunity();
    const channel = makeChannel(community);
    const pool = new FakePool();
    const client = new ConcordClient(community, pool, localIdentity(generateSecretKey()));
    const author = localIdentity(generateSecretKey());

    await client.sendTyping(channel, author);
    expect(pool.published).toHaveLength(1);
    expect(pool.published[0].kind).toBe(KIND_WRAP_EPHEMERAL);
    const opened = openWrap(pool.published[0], channel.current.group);
    expect(opened.kind).toBe(KIND_TYPING);
    expect(opened.author).toBe(author.pk);
    expect(opened.tags).toContainEqual(["channel", channel.idHex]);
  });

  it("subscribeChannel delivers ephemeral typing wraps and durable chat, cursors durable only", async () => {
    const { community } = makeCommunity();
    const channel = makeChannel(community);
    const pool = new FakePool();
    const client = new ConcordClient(community, pool, localIdentity(generateSecretKey()));
    const author = localIdentity(generateSecretKey());

    const kinds: number[] = [];
    const cursors: Array<{ pk: string; at: number }> = [];
    client.subscribeChannel(
      channel,
      (chat) => kinds.push(chat.kind),
      undefined,
      (pk, at) => cursors.push({ pk, at }),
    );

    await client.sendTyping(channel, author);
    const { wrap } = await client.sendChat(channel, { content: "hi", author });
    for (const event of pool.published) pool.emit(event);
    await new Promise((r) => setTimeout(r, 20));

    expect(kinds.sort()).toEqual([KIND_MESSAGE, KIND_TYPING].sort());
    // Only the durable chat wrap advances the cursor.
    expect(cursors).toHaveLength(1);
    expect(cursors[0].pk).toBe(channel.current.group.pk);
    expect(cursors[0].at).toBe(wrap.created_at);
  });

  it("publishManifest publishes a valid kind 10304 command manifest", async () => {
    const { community } = makeCommunity();
    const pool = new FakePool();
    const primary = localIdentity(generateSecretKey());
    const client = new ConcordClient(community, pool, primary);

    await client.publishManifest([
      {
        name: "bridge",
        description: "Manage the bridge",
        args: [
          { name: "action", type: "choice", required: true, choices: ["confirm"] },
          { name: "code", type: "string", required: true },
        ],
      },
      { name: "help", description: "Show help" },
    ]);

    expect(pool.published).toHaveLength(1);
    const event = pool.published[0];
    expect(event.kind).toBe(KIND_BOT_MANIFEST);
    expect(event.pubkey).toBe(primary.pk);
    const manifest = JSON.parse(event.content);
    expect(manifest.v).toBe(1);
    expect(manifest.commands.map((c: { name: string }) => c.name)).toEqual(["bridge", "help"]);
    // Producer contract: description/required always present, choices only on choice args.
    expect(manifest.commands[0].args[0]).toEqual({
      name: "action",
      type: "choice",
      description: "",
      required: true,
      choices: ["confirm"],
    });
    expect(manifest.commands[0].args[1].choices).toBeUndefined();
  });

  it("backfillChannel returns opened chats oldest-first with the newest wrap timestamp", async () => {
    const { community } = makeCommunity();
    const channel = makeChannel(community);
    const scratch = new FakePool();
    const writer = new ConcordClient(community, scratch, localIdentity(generateSecretKey()));
    const author = localIdentity(generateSecretKey());

    const now = Date.now();
    await writer.sendChat(channel, { content: "older", author, ms: now - 60_000 });
    await writer.sendChat(channel, { content: "newer", author, ms: now });

    const pool = new FakePool([...scratch.published].reverse()); // relay order: newest first
    const client = new ConcordClient(community, pool, localIdentity(generateSecretKey()));
    const { chats, newestWrapAt } = await client.backfillChannel(channel, Math.min(...scratch.published.map(e => e.created_at)));

    expect(chats.map((c) => c.content)).toEqual(["older", "newer"]);
    expect(newestWrapAt).toBe(Math.max(...scratch.published.map((e) => e.created_at)));
  });
});

describe('durable delivery cursor', () => {
  it('does not advance past an opened wrap while its handler is still persisting it', async () => {
    const { community } = makeCommunity(); const channel = makeChannel(community);
    const pool = new FakePool(); const client = new ConcordClient(community, pool, localIdentity(generateSecretKey()));
    let entered!: () => void, release!: () => void, advanced!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const done = new Promise<void>(resolve => { advanced = resolve; });
    const cursors: number[] = [];
    client.subscribeChannel(channel, async () => { entered(); await pending; }, undefined, (_pk, at) => { cursors.push(at); advanced(); });
    const { wrap } = await client.sendChat(channel, { content: 'persist me', author: localIdentity(generateSecretKey()) });
    pool.emit(wrap); await started;
    expect(cursors).toEqual([]);
    release(); await done;
    expect(cursors).toEqual([wrap.created_at]);
  });

  it('bounds signed burst admission while a handler is blocked and pins overflow cursors', async () => {
    const { community } = makeCommunity(); const channel = makeChannel(community);
    const pool = new FakePool(); const client = new ConcordClient(community, pool, localIdentity(generateSecretKey()));
    const author = localIdentity(generateSecretKey());
    const wraps: NostrEvent[] = [];
    for (let i = 0; i < 206; i++) wraps.push((await client.sendChat(channel, { content: `burst ${i}`, author, ...(i === 200 ? { kind: 5, tags: [['e', 'ab'.repeat(32)]] } : {}) })).wrap);
    let enter!: () => void, release!: () => void, drain!: () => void;
    const started = new Promise<void>(resolve => { enter = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const drained = new Promise<void>(resolve => { drain = resolve; });
    const contents: string[] = []; const errors: unknown[] = []; const cursors: number[] = [];
    const handler = async (chat: { content: string }) => {
      contents.push(chat.content);
      if (contents.length === 1) { enter(); await blocked; }
      if (contents.length === 200) drain();
    };
    const onError = (_url: string, error: unknown) => { errors.push(error); };
    const onCursor = (_pk: string, at: number) => { cursors.push(at); };
    const unsubscribe = client.subscribeChannel(channel, handler, onError, onCursor);
    pool.emit(wraps[0]); await started;
    for (const wrap of wraps.slice(1, 205)) pool.emit(wrap);
    expect(contents).toHaveLength(1);
    expect(errors).toHaveLength(5);
    expect(cursors).toEqual([]);
    release(); await drained;
    // Once the admitted batch drains, new work is accepted without forgetting
    // that five durable wraps still require catch-up after this subscription.
    await new Promise(resolve => setTimeout(resolve, 0));
    pool.emit(wraps[205]);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(contents).toHaveLength(201);
    expect(contents.at(-1)).toBe('burst 205');
    expect(contents).not.toContain('burst 200');
    expect(cursors).toEqual([]);
    unsubscribe();
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 120_000;
      client.subscribeChannel(channel, handler, onError, onCursor);
      pool.emit((await client.sendChat(channel, { content: 'after resubscription', author })).wrap);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(contents.at(-1)).toBe('after resubscription');
      expect(cursors).toEqual([]);
    } finally { Date.now = realNow; }
  });

  it('recovers more than 500 signed wraps in bounded oldest-first batches', async () => {
    const { community } = makeCommunity(); const channel = makeChannel(community);
    const scratch = new FakePool(); const writer = new ConcordClient(community, scratch, localIdentity(generateSecretKey()));
    const author = localIdentity(generateSecretKey()); const base = Math.floor(Date.now() / 1000) - 1000;
    const wraps: NostrEvent[] = [];
    for (let i = 0; i < 505; i++) {
      const { wrap } = await writer.sendChat(channel, { content: `page ${i}`, author, ms: (base + i) * 1000 });
      wraps.push(finalizeEvent({ ...wrap, created_at: base + i }, channel.current.group.sk));
    }
    const client = new ConcordClient(community, new FakePool(wraps), localIdentity(generateSecretKey()));
    const contents: string[] = []; const sizes: number[] = [];
    const result = await client.backfillChannel(channel, base, 500, { onBatch: async batch => {
      sizes.push(batch.chats.length); contents.push(...batch.chats.map(chat => chat.content));
    } });
    expect(contents).toEqual(Array.from({ length: 505 }, (_, i) => `page ${i}`));
    expect(Math.max(...sizes)).toBeLessThan(500);
    expect(result.chats).toEqual([]); // Streaming consumers do not accumulate history.
    expect(result.newestWrapAt).toBe(base + 504);
    let batches = 0, committedAt = base;
    const settled = new Set<string>();
    await expect(client.backfillChannel(channel, base, 500, { onBatch: async batch => {
      if (++batches === 2) throw new Error('stop before second batch commits');
      batch.chats.forEach(chat => settled.add(chat.rumorId)); committedAt = batch.newestWrapAt!;
    } })).rejects.toThrow('stop before second batch commits');
    expect(committedAt).toBeLessThan(base + 504);
    const restarted = new ConcordClient(community, new FakePool(wraps), localIdentity(generateSecretKey()));
    for (const chat of (await restarted.backfillChannel(channel, committedAt - 1)).chats) settled.add(chat.rumorId);
    expect(settled.size).toBe(505);
  }, 15_000);

  it('fully recovers same-second ties instead of advancing past a truncated bucket', async () => {
    const { community } = makeCommunity(); const channel = makeChannel(community);
    const scratch = new FakePool(); const writer = new ConcordClient(community, scratch, localIdentity(generateSecretKey()));
    const author = localIdentity(generateSecretKey()); const at = Math.floor(Date.now() / 1000);
    const wraps: NostrEvent[] = [];
    for (let i = 0; i < 6; i++) {
      const { wrap } = await writer.sendChat(channel, { content: `tie ${i}`, author, ms: at * 1000 + i });
      wraps.push(finalizeEvent({ ...wrap, created_at: at }, channel.current.group.sk));
    }
    const client = new ConcordClient(community, new FakePool(wraps), localIdentity(generateSecretKey()));
    const result = await client.backfillChannel(channel, at, 3);
    expect(result.chats.map(chat => chat.content)).toEqual(Array.from({ length: 6 }, (_, i) => `tie ${i}`));
    expect(result.newestWrapAt).toBe(at);
  });

  it('does not certify catch-up from a partial relay read', async () => {
    const { community } = makeCommunity(); const channel = makeChannel(community);
    const pool = Object.assign(new FakePool(), { queryStrict: async () => { throw new Error('one configured relay unavailable'); }, enumerateRelay: async () => { throw new Error('one configured relay unavailable'); } });
    const client = new ConcordClient(community, pool, localIdentity(generateSecretKey()));
    let batches = 0;
    await expect(client.backfillChannel(channel, 0, 500, { onBatch: async () => { batches++; } })).rejects.toThrow('one configured relay unavailable');
    expect(batches).toBe(0);
  });

  it('keeps live cursor acknowledgement healthy after an ordinary mirror error', async () => {
    const { community } = makeCommunity(); const channel = makeChannel(community);
    const pool = new FakePool(); const client = new ConcordClient(community, pool, localIdentity(generateSecretKey()));
    const author = localIdentity(generateSecretKey()); let calls = 0, finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; }); const cursors: number[] = []; const errors: unknown[] = [];
    const router = { onConcordChat: async () => { if (++calls === 1) throw new Error('Discord 503'); return []; } };
    const link = { communityId: community.idHex, concordChannelIdHex: channel.idHex, discordGuildId: 'g', discordChannelId: 'c', enabled: true };
    client.subscribeChannel(channel, chat => deliverConcordChat(router, chat, link, error => errors.push(error)), undefined, (_pk, at) => {
      cursors.push(at); if (cursors.length === 2) finish();
    });
    pool.emit((await client.sendChat(channel, { content: 'temporary failure', author })).wrap);
    pool.emit((await client.sendChat(channel, { content: 'later success', author })).wrap);
    await done;
    expect(errors).toHaveLength(1);
    expect(cursors).toHaveLength(2);
    expect(() => client.assertDeliveryHealthy()).not.toThrow();
  });

  it('pins the cursor after a storage failure rather than advancing on a later success', async () => {
    const { community } = makeCommunity(); const channel = makeChannel(community);
    const pool = new FakePool(); const client = new ConcordClient(community, pool, localIdentity(generateSecretKey()));
    let calls = 0, finish!: () => void;
    const handled = new Promise<void>(resolve => { finish = resolve; });
    const cursors: number[] = []; const errors: unknown[] = [];
    client.subscribeChannel(channel, async () => { if (++calls === 1) throw new Error('storage unavailable'); finish(); }, (_url, error) => errors.push(error), (_pk, at) => cursors.push(at));
    const author = localIdentity(generateSecretKey());
    pool.emit((await client.sendChat(channel, { content: 'fails', author })).wrap);
    pool.emit((await client.sendChat(channel, { content: 'later', author })).wrap);
    await handled;
    expect(errors).toHaveLength(1);
    expect(cursors).toEqual([]);
  });
});

for (const cap of [4, 8, 300, 400]) it(`recovers a same-second inventory beyond a relay cap of ${cap}`, async () => {
  const { community } = makeCommunity(); const channel = makeChannel(community);
  const scratch = new FakePool(), writer = new ConcordClient(community, scratch, localIdentity(generateSecretKey()));
  const author = localIdentity(generateSecretKey()), at = Math.floor(Date.now() / 1000);
  const wraps: NostrEvent[] = [];
  for (let i = 0; i < cap + 3; i++) {
    const { wrap } = await writer.sendChat(channel, { content: `capped ${i}`, author, ms: at * 1000 + i });
    wraps.push(finalizeEvent({ ...wrap, created_at: at }, channel.current.group.sk));
  }
  const client = new ConcordClient(community, new FakePool(wraps, cap), localIdentity(generateSecretKey()));
  const runStart = Math.floor(Date.now() / 1000);
  const result = await client.backfillChannel(channel, at);
  expect(result.chats).toHaveLength(cap + 3);
  expect(result.certifiedUntil).toBe(runStart);
}, 15000);

it('does not certify a window until all payload batches finish and preserves verified source time', async () => {
  const { community } = makeCommunity(), channel = makeChannel(community), scratch = new FakePool();
  const writer = new ConcordClient(community, scratch, localIdentity(generateSecretKey()));
  const at = Math.floor(Date.now() / 1000), author = localIdentity(generateSecretKey());
  const { wrap } = await writer.sendChat(channel, { content: 'old rumor, newer wrap', author, ms: (at - 100) * 1000 });
  const verified = finalizeEvent({ ...wrap, created_at: at }, channel.current.group.sk);
  const client = new ConcordClient(community, new FakePool([verified]), localIdentity(generateSecretKey()));
  const certified: number[] = [];
  await expect(client.backfillChannel(channel, at, 500, {
    onBatch: async batch => { expect(batch.chats[0].sourceWrapCreatedAt).toBe(at); expect(batch.chats[0].createdAt).toBe(at - 100); throw new Error('durability failed'); },
    onWindowComplete: async w => { certified.push(w.until); },
  })).rejects.toThrow('durability failed');
  expect(certified).toEqual([]);
});

it('splits decoded byte overflow and fails closed when one second still exceeds the budget', async () => {
  const { community } = makeCommunity(), channel = makeChannel(community), scratch = new FakePool();
  const writer = new ConcordClient(community, scratch, localIdentity(generateSecretKey())), author = localIdentity(generateSecretKey());
  const at = Math.floor(Date.now() / 1000) - 10, wraps: NostrEvent[] = [];
  // Signed payloads: the decoded content plus retained seal exceeds 16 MiB in
  // one combined window, while each half fits. No mocked byte estimator.
  for (let i = 0; i < 240; i++) {
    const { wrap } = await writer.sendChat(channel, { content: 'x'.repeat(35_000), author, ms: (at + (i < 120 ? 0 : 1)) * 1000 + i });
    wraps.push(finalizeEvent({ ...wrap, created_at: at + (i < 120 ? 0 : 1) }, channel.current.group.sk));
  }
  const client = new ConcordClient(community, new FakePool(wraps), localIdentity(generateSecretKey()));
  const windows: number[] = []; let delivered = 0;
  await client.backfillChannel(channel, at, 500, { onBatch: async b => { delivered += b.chats.length; }, onWindowComplete: async w => { windows.push(w.until); } });
  expect(delivered).toBe(240); expect(windows[0]).toBe(at); expect(windows.length).toBeGreaterThan(1);
  const sameSecond = wraps.map(w => finalizeEvent({ ...w, created_at: at }, channel.current.group.sk));
  const oversized = new ConcordClient(community, new FakePool(sameSecond), localIdentity(generateSecretKey()));
  let completed = false;
  await expect(oversized.backfillChannel(channel, at, 500, { onBatch: async () => {}, onWindowComplete: async () => { completed = true; } })).rejects.toThrow('second exceeds');
  expect(completed).toBe(false);
}, 30_000);
