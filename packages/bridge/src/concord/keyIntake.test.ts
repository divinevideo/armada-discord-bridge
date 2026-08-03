import { describe, expect, it } from "bun:test";
import {
  buildDirectInviteRumor,
  bytesToHex,
  channelsView,
  mintCommunity,
  random32,
  sealDirectInvite,
  wrapDirectInvite,
} from "@armada-bridge/concord-core";
import type { CommunityV2, FoldedControl, InviteBundle } from "@armada-bridge/concord-core";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { NostrEvent } from "nostr-tools/pure";

import { intakeDirectInviteKeys } from "./keyIntake";
import type { RelayLike } from "./pool";
import { localIdentity } from "./signer";

/** Serves canned events to every query; tag filtering is the intake's job. */
class CannedPool implements RelayLike {
  constructor(private readonly canned: NostrEvent[] = []) {}
  async query(): Promise<NostrEvent[]> {
    return this.canned;
  }
  async publish(): Promise<void> {}
  subscribe(): () => void {
    return () => {};
  }
  async close(): Promise<void> {}
}

function bundleFor(community: CommunityV2, channels: InviteBundle["channels"]): InviteBundle {
  return {
    community_id: community.idHex,
    owner: community.owner,
    owner_salt: bytesToHex(community.ownerSalt),
    community_root: bytesToHex(community.root),
    root_epoch: Number(community.rootEpoch),
    channels,
    relays: community.relays,
    name: community.name,
  };
}

/** The giftwrap Armada sends when someone adds an npub to a private channel. */
async function directInvite(
  bundle: InviteBundle,
  inviterSk: Uint8Array,
  recipientPk: string,
): Promise<NostrEvent> {
  const inviter = localIdentity(inviterSk);
  const rumor = buildDirectInviteRumor(bundle, inviter.pk);
  const seal = await sealDirectInvite(rumor, recipientPk, inviter.signer);
  return wrapDirectInvite(seal, recipientPk);
}

function community(): CommunityV2 {
  const ownerSk = generateSecretKey();
  return mintCommunity("Bridge Test", getPublicKey(ownerSk), ["wss://relay.example"]).community;
}

/** A control fold naming one private channel, as the Control Plane would. */
function foldWithPrivateChannel(idHex: string, name: string): FoldedControl {
  return {
    channels: new Map([
      [idHex, { channelIdHex: idHex, name, isPrivate: true, deleted: false, metadata: { name, private: true } }],
    ]),
  } as unknown as FoldedControl;
}

describe("direct-invite key intake", () => {
  it("merges a private-channel key granted after the bridge joined", async () => {
    const target = community();
    const bridge = localIdentity(generateSecretKey());
    const inviterSk = generateSecretKey();

    const channelId = bytesToHex(random32());
    const channelKey = bytesToHex(random32());
    const wrap = await directInvite(
      bundleFor(target, [{ id: channelId, key: channelKey, epoch: 0, name: "mods-only" }]),
      inviterSk,
      bridge.pk,
    );

    // Before: the channel is in the control fold, but `channelsView` omits it
    // rather than teasing a room whose key we do not hold.
    const fold = foldWithPrivateChannel(channelId, "mods-only");
    expect(channelsView(target, fold)).toEqual([]);

    const result = await intakeDirectInviteKeys([new CannedPool([wrap])], bridge, target);
    expect(result.learned).toEqual([channelId]);
    expect(result.community.privateChannels.map((c) => bytesToHex(c.key))).toEqual([channelKey]);
    expect(channelsView(result.community, fold).map((c) => c.name)).toEqual(["mods-only"]);
  });

  it("ignores a bundle minted by another community", async () => {
    const target = community();
    const other = community();
    const bridge = localIdentity(generateSecretKey());

    const wrap = await directInvite(
      bundleFor(other, [{ id: bytesToHex(random32()), key: bytesToHex(random32()), epoch: 0, name: "theirs" }]),
      generateSecretKey(),
      bridge.pk,
    );

    const result = await intakeDirectInviteKeys([new CannedPool([wrap])], bridge, target);
    expect(result.learned).toEqual([]);
    expect(result.community).toBe(target);
  });

  it("adopts a re-vend that advances a channel epoch we already hold", async () => {
    const target = community();
    const bridge = localIdentity(generateSecretKey());
    const channelId = random32();
    const oldKey = random32();
    const newKey = bytesToHex(random32());
    // Already holding epoch 0 — the shape after an earlier grant.
    const held: CommunityV2 = {
      ...target,
      privateChannels: [{ id: channelId, key: oldKey, epoch: 0n, name: "mods-only" }],
    };

    const wrap = await directInvite(
      bundleFor(target, [{ id: bytesToHex(channelId), key: newKey, epoch: 1, name: "mods-only" }]),
      generateSecretKey(),
      bridge.pk,
    );

    const result = await intakeDirectInviteKeys([new CannedPool([wrap])], bridge, held);
    expect(result.learned).toEqual([bytesToHex(channelId)]);
    expect(bytesToHex(result.community.privateChannels[0].key)).toBe(newKey);
    expect(result.community.privateChannels[0].epoch).toBe(1n);
  });

  it("cannot open an invite sealed to somebody else", async () => {
    const target = community();
    const bridge = localIdentity(generateSecretKey());
    const stranger = localIdentity(generateSecretKey());

    const wrap = await directInvite(
      bundleFor(target, [{ id: bytesToHex(random32()), key: bytesToHex(random32()), epoch: 0, name: "not-ours" }]),
      generateSecretKey(),
      stranger.pk,
    );

    const result = await intakeDirectInviteKeys([new CannedPool([wrap])], bridge, target);
    expect(result.learned).toEqual([]);
  });

  it("keeps the newer key when two vends name one channel, and retains the old one for history", async () => {
    const target = community();
    const bridge = localIdentity(generateSecretKey());
    const channelId = bytesToHex(random32());
    const oldKey = bytesToHex(random32());
    const newKey = bytesToHex(random32());

    const wraps = [
      await directInvite(
        bundleFor(target, [{ id: channelId, key: oldKey, epoch: 0, name: "mods-only" }]),
        generateSecretKey(),
        bridge.pk,
      ),
      await directInvite(
        bundleFor(target, [{ id: channelId, key: newKey, epoch: 1, name: "mods-only" }]),
        generateSecretKey(),
        bridge.pk,
      ),
    ];

    const result = await intakeDirectInviteKeys([new CannedPool(wraps)], bridge, target);
    const held = result.community.privateChannels;
    expect(held).toHaveLength(1);
    expect(bytesToHex(held[0].key)).toBe(newKey);
    expect(held[0].epoch).toBe(1n);
    // The superseded key survives as a prior: history sealed under epoch 0 has
    // to stay readable, or a rotation looks like the conversation restarting.
    expect(held[0].priors?.map((p) => bytesToHex(p.key))).toEqual([oldKey]);
  });
});
