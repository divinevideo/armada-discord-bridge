/**
 * Severance detection over synthetic communities (minted exactly as
 * scripts/fixtures/relay-events.ts mints them): each of the three cases fires,
 * and the lookalikes that must NOT fire stay quiet — an impostor's rotation at
 * the member-derivable rekey address, a half-published rotation, a tombstone
 * the owner never signed, and the ban→refound flow where the ban is the reason
 * and the rotation is only its secrecy mechanism.
 */

import { describe, expect, it } from "bun:test";
import {
  KIND_SEAL_ENCRYPTED,
  REKEY_BLOBS_PER_EVENT,
  ROOT_SCOPE_HEX,
  baseRekeyGroupKey,
  buildBanlistEdition,
  buildRekeyRumors,
  bytesToBase64,
  bytesToHex,
  controlGroups,
  controlSignerGroupKey,
  currentControlWriteGroup,
  encodeWrappedBaseKey,
  epochKeyCommitment,
  foldControlState,
  hex32,
  mintCommunity,
  myLocator,
  openControlWraps,
  random32,
  sealDissolved,
  sealEdition,
  sealRumor,
  wrapSeal,
} from "@armada-bridge/concord-core";
import type { CommunityV2, FoldedControl } from "@armada-bridge/concord-core";
import { decrypt as nip44Decrypt, encrypt as nip44Encrypt, getConversationKey } from "nostr-tools/nip44";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";

import { detectBan, detectSeverance, severanceDetail } from "./severance";

interface Identity {
  pk: string;
  signEvent(template: EventTemplate): Promise<NostrEvent>;
  nip44encrypt(counterparty: string, plaintext: string): string;
  nip44decrypt(counterparty: string, ciphertext: string): string;
}

function identity(): Identity {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  return {
    pk,
    async signEvent(template: EventTemplate) {
      return finalizeEvent(template, sk);
    },
    nip44encrypt: (counterparty: string, plaintext: string) =>
      nip44Encrypt(plaintext, getConversationKey(sk, counterparty)),
    nip44decrypt: (counterparty: string, ciphertext: string) =>
      nip44Decrypt(ciphertext, getConversationKey(sk, counterparty)),
  };
}

function minted(): { owner: Identity; community: CommunityV2 } {
  const owner = identity();
  const { community } = mintCommunity("Severance Fixture", owner.pk, ["wss://relay.example"]);
  return { owner, community };
}

/** Fold the control plane over whatever editions the caller sealed. */
function fold(community: CommunityV2, ownerPk: string, editions: NostrEvent[]): FoldedControl {
  return foldControlState(openControlWraps(editions, controlGroups(community)), community.id, ownerPk);
}

/** A Banlist edition naming `banned`, folded in (case 1's whole evidence). */
async function banlistFold(community: CommunityV2, owner: Identity, banned: string[]): Promise<FoldedControl> {
  const wrap = await sealEdition(
    buildBanlistEdition(community.id, banned, { actorPubkey: owner.pk, version: 1n }),
    currentControlWriteGroup(community),
    owner,
  );
  return fold(community, owner.pk, [wrap]);
}

/**
 * One base rotation minted FROM the community's current root (protocol.test.ts
 * §6's flow): per-recipient blobs at the recipients' locators, chunked the way
 * the wire chunks them, sealed at the base-rekey address. `chunkFilter` lets a
 * test hold chunks back — a rotation with a missing chunk is not a rotation.
 * `fillerBlobs` pads a chunk with tiny placeholder blobs: detection reads a
 * blob's LOCATOR (public inputs only) and never decrypts it, so a fixture
 * proving the chunk machinery need not pay for 120 real NIP-44s (which also
 * blow the wrap's 65,535-byte plaintext cap).
 */
async function refounding(
  community: CommunityV2,
  owner: Identity,
  opts: {
    recipients?: string[];
    fillerBlobs?: number;
    newEpoch?: bigint;
    prevEpoch?: bigint;
    ms?: number;
    chunkFilter?: (index: number) => boolean;
  } = {},
): Promise<{ wraps: NostrEvent[]; newEpoch: bigint; ms: number }> {
  const newEpoch = opts.newEpoch ?? 1n;
  const prevEpoch = opts.prevEpoch ?? community.rootEpoch;
  const ms = opts.ms ?? Date.now();
  const newRoot = random32();
  const newControlRoot = random32();
  const newControlPk = controlSignerGroupKey(newControlRoot, community.id, newEpoch).pk;
  const rekeyAddress = baseRekeyGroupKey(community.root, community.id, newEpoch);
  const memberPlain = bytesToBase64(encodeWrappedBaseKey(newEpoch, newRoot, hex32(newControlPk)));
  const blobs = [
    ...(opts.recipients ?? []).map((pk) => ({
      locator: myLocator(owner.pk, pk, ROOT_SCOPE_HEX, newEpoch),
      wrapped: owner.nip44encrypt(pk, memberPlain),
    })),
    ...Array.from({ length: opts.fillerBlobs ?? 0 }, (_, i) => ({ locator: `filler-${i}`, wrapped: "x" })),
  ];
  const rumors = buildRekeyRumors(
    owner.pk,
    {
      scope: { kind: "root" },
      newEpoch,
      prevEpoch,
      prevCommit: bytesToHex(epochKeyCommitment(prevEpoch, community.root)),
    },
    blobs,
    ms,
  );
  const wraps: NostrEvent[] = [];
  for (const [i, rumor] of rumors.entries()) {
    if (opts.chunkFilter && !opts.chunkFilter(i)) continue;
    wraps.push(wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, rekeyAddress, owner), rekeyAddress));
  }
  return { wraps, newEpoch, ms };
}

describe("severance: ban (the control plane bans the bridging identity)", () => {
  it("fires when the folded Banlist names the bridge's npub", async () => {
    const { owner, community } = minted();
    const me = identity();
    const folded = await banlistFold(community, owner, [me.pk]);
    expect(detectBan(folded, me.pk)).toEqual({ reason: "banned", pubkey: me.pk, bannedAtMs: expect.any(Number) });
    expect(detectSeverance({ wraps: [], community, me: me.pk, folded })?.reason).toBe("banned");
  });

  it("stays quiet when the Banlist names someone else", async () => {
    const { owner, community } = minted();
    const me = identity();
    const folded = await banlistFold(community, owner, [identity().pk]);
    expect(detectBan(folded, me.pk)).toBeUndefined();
    expect(detectSeverance({ wraps: [], community, me: me.pk, folded })).toBeUndefined();
  });

  it("without a fold there is no ban to read (an unread plane is not a ban)", () => {
    const { community } = minted();
    const me = identity();
    expect(detectBan(undefined, me.pk)).toBeUndefined();
    expect(detectSeverance({ wraps: [], community, me: me.pk })).toBeUndefined();
  });
});

describe("severance: refounding (the root epoch advanced)", () => {
  it("fires when an authorized rotation supersedes the held epoch, carried forward", async () => {
    const { owner, community } = minted();
    const me = identity();
    const folded = fold(community, owner.pk, []);
    const { wraps, newEpoch } = await refounding(community, owner, { recipients: [me.pk] });
    const verdict = detectSeverance({ wraps, community, me: me.pk, folded, joinedAtMs: Date.now() - 60_000 });
    expect(verdict).toMatchObject({ reason: "refounded", newEpoch, refounder: owner.pk, carried: true, excluded: false });
    expect(severanceDetail(verdict!)).toMatch(/refounded at epoch 1/);
    expect(severanceDetail(verdict!)).toMatch(/resume/);
  });

  it("reads a complete rotation with no blob after the join as exclusion", async () => {
    const { owner, community } = minted();
    const me = identity();
    const folded = fold(community, owner.pk, []);
    const { wraps, ms } = await refounding(community, owner, { recipients: [] });
    const verdict = detectSeverance({ wraps, community, me: me.pk, folded, joinedAtMs: ms - 60_000 });
    expect(verdict).toMatchObject({ reason: "refounded", carried: false, excluded: true });
    expect(severanceDetail(verdict!)).toMatch(/excluded/);
  });

  it("a rotation that predates the join is a stale bundle, not an exclusion", async () => {
    // The bridge joined ON a superseded epoch (a stale bundle dropped it on
    // history). The rotation that replaced that epoch carried no blob for a
    // member who did not exist yet — the keys are still superseded (so this is
    // still a refounding to act on), but nobody removed anyone.
    const { owner, community } = minted();
    const me = identity();
    const folded = fold(community, owner.pk, []);
    const { wraps, ms } = await refounding(community, owner, { recipients: [] });
    const verdict = detectSeverance({ wraps, community, me: me.pk, folded, joinedAtMs: ms + 60_000 });
    expect(verdict).toMatchObject({ reason: "refounded", carried: false, excluded: false });
    expect(severanceDetail(verdict!)).toMatch(/before this bridge joined/);
  });

  it("ignores an impostor's rotation at the rekey address (griefing closed)", async () => {
    // The base-rekey address derives from the PRIOR root — which every member
    // and every ex-member holds — so anyone can publish there. What a stranger
    // cannot do is pass the same gate key adoption uses (un-banned, holds BAN,
    // citation confirmed), so their "rotation" must sever nothing.
    const { owner, community } = minted();
    const me = identity();
    const folded = fold(community, owner.pk, []);
    const impostor = identity();
    const newEpoch = 1n;
    const rekeyAddress = baseRekeyGroupKey(community.root, community.id, newEpoch);
    const rumor = buildRekeyRumors(
      impostor.pk,
      {
        scope: { kind: "root" },
        newEpoch,
        prevEpoch: community.rootEpoch,
        prevCommit: bytesToHex(epochKeyCommitment(community.rootEpoch, community.root)),
      },
      [],
      Date.now(),
    )[0];
    const wraps = [wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, rekeyAddress, impostor), rekeyAddress)];
    expect(detectSeverance({ wraps, community, me: me.pk, folded })).toBeUndefined();
  });

  it("ignores a half-published rotation (a missing chunk is never a removal)", async () => {
    const { owner, community } = minted();
    const me = identity();
    const folded = fold(community, owner.pk, []);
    const { wraps } = await refounding(community, owner, {
      recipients: [me.pk],
      fillerBlobs: REKEY_BLOBS_PER_EVENT,
      chunkFilter: (i) => i === 0, // hold the last chunk back
    });
    // My own blob is in the held chunk, and it still must not fire: a rotation
    // missing a chunk is indistinguishable from a rotation that lists me only
    // in the chunk someone withheld (rekey.ts — never a removal).
    expect(wraps.length).toBe(1);
    expect(detectSeverance({ wraps, community, me: me.pk, folded, joinedAtMs: Date.now() - 60_000 })).toBeUndefined();
  });

  it("ignores a rotation replacing an epoch above the held one (a gap, not a verdict)", async () => {
    const { owner, community } = minted();
    const me = identity();
    const folded = fold(community, owner.pk, []);
    const { wraps } = await refounding(community, owner, {
      recipients: [me.pk],
      prevEpoch: community.rootEpoch + 1n, // we missed one in between
    });
    expect(detectSeverance({ wraps, community, me: me.pk, folded })).toBeUndefined();
  });

  it("ignores a rotation that does not supersede the held epoch", async () => {
    const { owner, community } = minted();
    const me = identity();
    const folded = fold(community, owner.pk, []);
    const { wraps } = await refounding(community, owner, { recipients: [me.pk], newEpoch: 2n, prevEpoch: 1n });
    // prevEpoch 1 is a gap from held epoch 0 — same as above, but at an epoch
    // whose own newEpoch also never touched what we hold.
    expect(detectSeverance({ wraps, community, me: me.pk, folded })).toBeUndefined();
  });
});

describe("severance: dissolution (the owner dissolved the community)", () => {
  it("fires on the owner's tombstone at the dissolved plane", async () => {
    const { owner, community } = minted();
    const me = identity();
    const wraps = [await sealDissolved(community.id, owner.pk, owner)];
    const verdict = detectSeverance({ wraps, community, me: me.pk, folded: fold(community, owner.pk, []) });
    expect(verdict).toEqual({ reason: "dissolved" });
    expect(severanceDetail(verdict!)).toMatch(/dissolved/);
  });

  it("ignores a tombstone the owner never signed", async () => {
    const { community } = minted();
    const me = identity();
    const impostor = identity();
    const wraps = [await sealDissolved(community.id, impostor.pk, impostor)];
    expect(detectSeverance({ wraps, community, me: me.pk, folded: fold(community, impostor.pk, []) })).toBeUndefined();
  });
});

describe("severance: verdict priority", () => {
  it("terminal truth first: dissolved outranks banned and refounded", async () => {
    const { owner, community } = minted();
    const me = identity();
    const folded = await banlistFold(community, owner, [me.pk]);
    const { wraps: rekeyWraps } = await refounding(community, owner, { recipients: [] });
    const wraps = [...rekeyWraps, await sealDissolved(community.id, owner.pk, owner)];
    expect(detectSeverance({ wraps, community, me: me.pk, folded, joinedAtMs: Date.now() - 60_000 })?.reason).toBe("dissolved");
  });

  it("the ban is the reason; the ban→refound rotation is only its secrecy mechanism", async () => {
    // The protocol's ban flow is banlist + Refounding that excludes the target
    // (protocol.test.ts §6). The verdict must name the ban — an operator acting
    // on "refounded" would look for a key rotation to adopt and find none.
    const { owner, community } = minted();
    const me = identity();
    const folded = await banlistFold(community, owner, [me.pk]);
    const { wraps } = await refounding(community, owner, { recipients: [] });
    const verdict = detectSeverance({ wraps, community, me: me.pk, folded, joinedAtMs: Date.now() - 60_000 });
    expect(verdict?.reason).toBe("banned");
    expect(severanceDetail(verdict!)).toMatch(/banned/);
  });
});
