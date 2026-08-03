import { describe, expect, it } from "bun:test";

import { channelsView, mintCommunity } from "./community";
import { bytesToHex, random32 } from "./derive";
import { emptyRoles } from "./roles";

import type { FoldedControl, FoldedChannel } from "./control";
import type { ChannelMetadata, CommunityV2, PrivateChannelKey } from "./types";

const OWNER = "f".repeat(64);

function foldWith(channels: FoldedChannel[]): FoldedControl {
  return {
    roster: emptyRoles(),
    ownerHex: OWNER,
    channels: new Map(channels.map((c) => [c.channelIdHex, c])),
    banned: new Set(),
    liveInviteLinks: new Set(),
    registriesByCreator: new Map(),
    heads: new Map(),
    headEditions: new Map(),
    incomplete: [],
    bannedAt: new Map(),
  } as unknown as FoldedControl;
}

function channelDef(id: Uint8Array, metadata: ChannelMetadata): FoldedChannel {
  return {
    channelIdHex: bytesToHex(id),
    name: metadata.name,
    isPrivate: metadata.private,
    deleted: false,
    metadata,
  };
}

/**
 * The lock is `isPrivate`, full stop. CORD-03 splits channels by who may read
 * them: a Public one derives its key from the `community_root` every member
 * holds, a Private one has an independent key delivered only to the holders of
 * a Role scoped to it. There is no third state and nothing else to consult.
 */
describe("channelsView (CORD-03 channel kinds)", () => {
  const held = (id: Uint8Array, name: string): PrivateChannelKey => ({ id, key: random32(), epoch: 0n, name });

  it("a private channel is private whether or not a role is scoped to it", () => {
    // A private channel nobody is scoped to is a room only its key holders can
    // read — degenerate, but not open, and never renders as a normal channel.
    const { community: base } = mintCommunity("Fleet", OWNER, ["wss://a.test"]);
    const scopedId = random32();
    const orphanId = random32();
    const community: CommunityV2 = {
      ...base,
      privateChannels: [held(scopedId, "scoped"), held(orphanId, "orphan")],
    };
    const folded = foldWith([
      channelDef(scopedId, { name: "scoped", private: true }),
      channelDef(orphanId, { name: "orphan", private: true }),
    ]);

    const byName = new Map(channelsView(community, folded).map((c) => [c.name, c]));
    expect(byName.get("scoped")?.isPrivate).toBe(true);
    expect(byName.get("orphan")?.isPrivate).toBe(true);
  });

  it("public channels are never private", () => {
    const { community, generalChannelId } = mintCommunity("Fleet", OWNER, ["wss://a.test"]);
    const folded = foldWith([channelDef(generalChannelId, { name: "general", private: false })]);
    expect(channelsView(community, folded)[0]?.isPrivate).toBe(false);
  });

  it("a converted channel keeps BOTH eras of history readable", () => {
    // The field case: a channel written to while private, then unprivated.
    // Both the root-derived stream (public era) and every held channel key
    // (private era) must be queried, or half the conversation disappears.
    const { community: base } = mintCommunity("Fleet", OWNER, ["wss://a.test"]);
    const id = random32();
    const community: CommunityV2 = {
      ...base,
      privateChannels: [{ id, key: random32(), epoch: 2n, name: "c", priors: [{ key: random32(), epoch: 1n }] }],
    };

    // Now PUBLIC: writes go to the root stream, private-era streams remain.
    const asPublic = channelsView(community, foldWith([channelDef(id, { name: "c", private: false })]))[0];
    expect(asPublic.current.epoch).toBe(community.rootEpoch);
    expect(asPublic.streams.map((s) => s.epoch).sort()).toEqual([0n, 1n, 2n]);

    // Still PRIVATE: writes go to the current channel key, root-era remains.
    const asPrivate = channelsView(community, foldWith([channelDef(id, { name: "c", private: true })]))[0];
    expect(asPrivate.current.epoch).toBe(2n);
    expect(asPrivate.streams.map((s) => s.epoch).sort()).toEqual([0n, 1n, 2n]);
  });

  it("a held-but-unfolded private channel still reads as private", () => {
    const { community: base } = mintCommunity("Fleet", OWNER, ["wss://a.test"]);
    const id = random32();
    const community: CommunityV2 = { ...base, privateChannels: [held(id, "pending")] };
    // Holding an independent channel key is itself proof the channel is
    // private: a public one would derive from the root and need no key.
    expect(channelsView(community, foldWith([]))[0]?.isPrivate).toBe(true);
  });
});
