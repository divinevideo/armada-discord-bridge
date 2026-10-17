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
import { identityRelayPool } from "./identityPool";
import { generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
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

/**
 * Sender authorization is exercised on its own below; the merge-semantics
 * tests hold it open so an epoch/union assertion fails for the reason it
 * names rather than because a fixture key holds no role.
 */
const anySender = { isAuthorizedSender: () => true };

/** Only these pubkeys may vend, as a real roster check would decide. */
const onlyFrom = (...pks: string[]) => ({ isAuthorizedSender: (pk: string) => pks.includes(pk) });

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

    const result = await intakeDirectInviteKeys([new CannedPool([wrap])], bridge, target, anySender);
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

    const result = await intakeDirectInviteKeys([new CannedPool([wrap])], bridge, target, anySender);
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

    const result = await intakeDirectInviteKeys([new CannedPool([wrap])], bridge, held, anySender);
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

    const result = await intakeDirectInviteKeys([new CannedPool([wrap])], bridge, target, anySender);
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

    const result = await intakeDirectInviteKeys([new CannedPool(wraps)], bridge, target, anySender);
    const held = result.community.privateChannels;
    expect(held).toHaveLength(1);
    expect(bytesToHex(held[0].key)).toBe(newKey);
    expect(held[0].epoch).toBe(1n);
    // The superseded key survives as a prior: history sealed under epoch 0 has
    // to stay readable, or a rotation looks like the conversation restarting.
    expect(held[0].priors?.map((p) => bytesToHex(p.key))).toEqual([oldKey]);
  });

  it("takes the key when the sender is entitled to vend it", async () => {
    const target = community();
    const bridge = localIdentity(generateSecretKey());
    const inviterSk = generateSecretKey();
    const inviterPk = localIdentity(inviterSk).pk;
    const channelId = bytesToHex(random32());

    const wrap = await directInvite(
      bundleFor(target, [{ id: channelId, key: bytesToHex(random32()), epoch: 0, name: "mods-only" }]),
      inviterSk,
      bridge.pk,
    );

    const result = await intakeDirectInviteKeys(
      [new CannedPool([wrap])],
      bridge,
      target,
      onlyFrom(inviterPk),
    );
    expect(result.learned).toEqual([channelId]);
  });

  it("refuses a bundle from a sender with no authority to vend", async () => {
    const target = community();
    const bridge = localIdentity(generateSecretKey());
    const strangerSk = generateSecretKey();
    const channelId = bytesToHex(random32());

    // Everything an outsider needs is public: community_id, owner and
    // owner_salt ride in every invite, and the bridge publishes its own npub.
    // So this bundle is well-formed and genuinely sealed to us — only the
    // sender's standing separates it from a real grant.
    const wrap = await directInvite(
      bundleFor(target, [{ id: channelId, key: bytesToHex(random32()), epoch: 0, name: "mods-only" }]),
      strangerSk,
      bridge.pk,
    );

    const result = await intakeDirectInviteKeys(
      [new CannedPool([wrap])],
      bridge,
      target,
      onlyFrom(localIdentity(generateSecretKey()).pk),
    );
    expect(result.learned).toEqual([]);
    expect(result.community).toBe(target);
  });

  it("refuses a stranger's higher-epoch bundle for a channel we already hold", async () => {
    const target = community();
    const bridge = localIdentity(generateSecretKey());
    const channelId = random32();
    const realKey = random32();
    const held: CommunityV2 = {
      ...target,
      privateChannels: [{ id: channelId, key: realKey, epoch: 0n, name: "mods-only" }],
    };

    // The takeover shape: unionChannelKeys resolves a collision by HIGHER
    // EPOCH WINS, so an unauthorized vend at epoch 9999 would otherwise become
    // the channel's write target and every mirrored message would be sealed
    // where only the attacker can read it.
    const wrap = await directInvite(
      bundleFor(target, [
        { id: bytesToHex(channelId), key: bytesToHex(random32()), epoch: 9999, name: "mods-only" },
      ]),
      generateSecretKey(),
      bridge.pk,
    );

    const result = await intakeDirectInviteKeys(
      [new CannedPool([wrap])],
      bridge,
      held,
      onlyFrom(localIdentity(generateSecretKey()).pk),
    );
    expect(result.learned).toEqual([]);
    expect(bytesToHex(result.community.privateChannels[0].key)).toBe(bytesToHex(realKey));
    expect(result.community.privateChannels[0].epoch).toBe(0n);
  });
});

it("restart recovers private keys only by authenticating the bridge identity to protected inbox relays", async () => {
  const target = community();
  const bridgeSk = generateSecretKey();
  const bridge = localIdentity(bridgeSk);
  const inviterSk = generateSecretKey();
  const channelId = bytesToHex(random32());
  const channelKey = bytesToHex(random32());
  const wrap = await directInvite(bundleFor(target, [{ id: channelId, key: channelKey, epoch: 0, name: "private" }]), inviterSk, bridge.pk);
  const server = Bun.serve<{ authenticated: boolean }>({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) { if (server.upgrade(request, { data: { authenticated: false } })) return; return new Response("no"); },
    websocket: {
      open(ws) { ws.send(JSON.stringify(["AUTH", "synthetic-inbox-challenge"])); },
      message(ws, value) {
        const frame = JSON.parse(String(value));
        if (frame[0] === "AUTH") {
          const event = frame[1];
          ws.data.authenticated = event.pubkey === bridge.pk && verifyEvent(event) && event.kind === 22242 && event.tags.some((t: string[]) => t[0] === "challenge" && t[1] === "synthetic-inbox-challenge");
          ws.send(JSON.stringify(["OK", event.id, ws.data.authenticated, ""]));
        }
        if (frame[0] === "REQ") {
          if (!ws.data.authenticated) { ws.send(JSON.stringify(["CLOSED", frame[1], "auth-required: bridge inbox"])); return; }
          ws.send(JSON.stringify(["EVENT", frame[1], wrap]));
          ws.send(JSON.stringify(["EOSE", frame[1]]));
        }
      },
    },
  });
  try {
    // Fresh pools model both the initial boot and a restart; no keys survive in memory.
    for (let boot = 0; boot < 2; boot++) {
      const communityPool = identityRelayPool([`ws://127.0.0.1:${server.port}`], bridgeSk);
      const floorPool = identityRelayPool([`ws://127.0.0.1:${server.port}`], bridgeSk);
      try {
        const recovered = await intakeDirectInviteKeys([communityPool, floorPool], bridge, target, onlyFrom(getPublicKey(inviterSk)));
        expect(recovered.learned).toEqual([channelId]);
        expect(bytesToHex(recovered.community.privateChannels[0].key)).toBe(channelKey);
      } finally { await communityPool.close(); await floorPool.close(); }
    }
  } finally { server.stop(true); }
}, 15000);
