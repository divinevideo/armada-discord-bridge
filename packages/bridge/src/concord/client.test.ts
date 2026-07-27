import { describe, expect, it } from "bun:test";
import {
  KIND_JOIN_LEAVE,
  KIND_MESSAGE,
  STOCK_RELAYS,
  buildBundleEvent,
  buildChannelEdition,
  buildInviteUrl,
  bytesToHex,
  channelGroupKey,
  currentControlGroup,
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
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { NostrEvent } from "nostr-tools/pure";
import type { NostrFilter } from "@nostrify/nostrify";

import { ConcordClient, hasProxyTag, proxyTag, resolveInvite } from "./client";
import type { RelayLike } from "./pool";
import { localIdentity } from "./signer";

/** In-memory pool: canned query results, captured publishes, manual emit. */
class FakePool implements RelayLike {
  published: NostrEvent[] = [];
  private subs: Array<{ filters: NostrFilter[]; onEvent: (e: NostrEvent) => void }> = [];
  constructor(private readonly canned: NostrEvent[] = []) {}
  async query(filters: NostrFilter[]): Promise<NostrEvent[]> {
    return this.canned.filter((event) => matches(filters, event));
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
    const client = new ConcordClient(community, pool, localIdentity(generateSecretKey()));

    let folds = 0;
    client.subscribeControl(() => folds++);

    const owner = localIdentity(ownerSk);
    const channelId = new Uint8Array(32).fill(9);
    const edition = buildChannelEdition(channelId, { name: "bridged", private: false }, {
      actorPubkey: owner.pk,
      version: 1n,
    });
    const wrap = await sealEdition(edition, currentControlGroup(community), owner.signer);
    pool.emit(wrap);

    expect(folds).toBe(1);
    const names = client.channels().map((c) => c.name);
    expect(names).toContain("bridged");
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
