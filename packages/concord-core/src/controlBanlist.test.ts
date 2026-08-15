/**
 * Banlist authority, as this package folds it.
 *
 * Deliberately NOT in `control.test.ts`: that file is vendored wholesale from
 * the Armada client by `sync-from-armada.sh` and every re-vendor would drop
 * these. The rules they cover are a local divergence from upstream — see the
 * banlist section of control.ts — and they belong somewhere the sync leaves
 * alone, next to the change they pin down.
 *
 * All three cases are the same shape: someone who holds BAN using it on people
 * they do not outrank, or on themselves.
 */

import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";
import { describe, expect, it } from "bun:test";

import {
  buildBanlistEdition,
  buildGrantEdition,
  buildMetadataEdition,
  buildRoleEdition,
  foldControlState,
  openControlWraps,
  sealEdition,
} from "./control";
import { bytesToHex, communityIdOf, controlGroupKey, hex32, random32, type GroupKey } from "./derive";
import type { Rumor } from "./stream";
import { adminRole, moderatorRole } from "./roles";

function signer(sk = generateSecretKey()) {
  return { sk, pubkey: getPublicKey(sk), signEvent: async (t: EventTemplate) => finalizeEvent(t, sk) };
}

function citeGrant(grantWrap: NostrEvent, control: GroupKey, version = 1n) {
  const [parsed] = openControlWraps([grantWrap], [control]);
  return { entityId: parsed.entityId, version, editionHash: parsed.selfHash };
}

async function makeCommunity() {
  const owner = signer();
  const ownerSalt = random32();
  const communityId = communityIdOf(hex32(owner.pubkey), ownerSalt);
  const root = random32();
  const control = controlGroupKey(root, communityId, 0);
  return { owner, ownerSalt, communityId, root, control };
}

/**
 * A community with an Admin (position 1) and a Moderator (position 2), both
 * granted by the owner — the stock roles, whose permission sets are what make
 * these attacks reachable in the first place: `moderatorRole` carries BAN.
 */
async function staffedCommunity() {
  const base = await makeCommunity();
  const { owner, communityId, control } = base;
  const admin = signer();
  const mod = signer();
  const adm = adminRole(bytesToHex(random32()));
  const mrole = moderatorRole(bytesToHex(random32()));

  const admGrant = await sealEdition(
    buildGrantEdition(communityId, { member: admin.pubkey, roleIds: [adm.roleId] }, { actorPubkey: owner.pubkey, version: 1n }),
    control,
    owner,
  );
  const modGrant = await sealEdition(
    buildGrantEdition(communityId, { member: mod.pubkey, roleIds: [mrole.roleId] }, { actorPubkey: owner.pubkey, version: 1n }),
    control,
    owner,
  );
  const wraps: NostrEvent[] = [
    await sealEdition(buildRoleEdition(adm, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
    await sealEdition(buildRoleEdition(mrole, { actorPubkey: owner.pubkey, version: 1n }), control, owner),
    admGrant,
    modGrant,
  ];
  return { ...base, admin, mod, adm, mrole, admGrant, modGrant, wraps };
}

describe("banlist authority", () => {
  it("a moderator cannot ban the admins above them", async () => {
    const { owner, communityId, control, admin, mod, modGrant, wraps } = await staffedCommunity();
    const outsider = signer();

    // The moderator holds BAN. Naming an Admin is still not theirs to do; the
    // outsider in the same list is, so the edition is honored in part.
    wraps.push(
      await sealEdition(
        buildBanlistEdition(communityId, [admin.pubkey, outsider.pubkey], {
          actorPubkey: mod.pubkey,
          version: 1n,
          authority: citeGrant(modGrant, control),
        }),
        control,
        mod,
      ),
    );

    const folded = foldControlState(openControlWraps(wraps, [control]), communityId, owner.pubkey);
    expect(folded.banned.has(admin.pubkey)).toBe(false);
    expect(folded.banned.has(outsider.pubkey)).toBe(true);
    // And the entry they were not entitled to leaves no trace in the history
    // either, which is what phantom-member suppression reads.
    expect(folded.bannedAt.has(admin.pubkey)).toBe(false);
  });

  it("a moderator cannot ban a peer moderator (equal does not act on equal)", async () => {
    const { owner, communityId, control, mod, mrole, modGrant, wraps } = await staffedCommunity();
    const peer = signer();
    wraps.push(
      await sealEdition(
        buildGrantEdition(communityId, { member: peer.pubkey, roleIds: [mrole.roleId] }, { actorPubkey: owner.pubkey, version: 1n }),
        control,
        owner,
      ),
      await sealEdition(
        buildBanlistEdition(communityId, [peer.pubkey], {
          actorPubkey: mod.pubkey,
          version: 1n,
          authority: citeGrant(modGrant, control),
        }),
        control,
        mod,
      ),
    );

    const folded = foldControlState(openControlWraps(wraps, [control]), communityId, owner.pubkey);
    expect(folded.banned.has(peer.pubkey)).toBe(false);
  });

  it("a banned moderator cannot publish the version that unbans them", async () => {
    const { owner, communityId, control, mod, modGrant, wraps } = await staffedCommunity();

    // The owner bans the moderator. A ban does not strip the role, so the
    // moderator still holds BAN — which used to be enough to publish v2.
    const v1 = await sealEdition(
      buildBanlistEdition(communityId, [mod.pubkey], { actorPubkey: owner.pubkey, version: 1n }),
      control,
      owner,
    );
    const [v1Parsed] = openControlWraps([v1], [control]);
    wraps.push(
      v1,
      await sealEdition(
        buildBanlistEdition(communityId, [], {
          actorPubkey: mod.pubkey,
          version: 2n,
          prevHash: v1Parsed.selfHash,
          authority: citeGrant(modGrant, control),
        }),
        control,
        mod,
      ),
    );

    const folded = foldControlState(openControlWraps(wraps, [control]), communityId, owner.pubkey);
    expect(folded.banned.has(mod.pubkey)).toBe(true);
  });

  it("a moderator's list does not lift a ban the owner issued on someone above them", async () => {
    const { owner, communityId, control, admin, mod, modGrant, wraps } = await staffedCommunity();
    const outsider = signer();

    const v1 = await sealEdition(
      buildBanlistEdition(communityId, [admin.pubkey], { actorPubkey: owner.pubkey, version: 1n }),
      control,
      owner,
    );
    const [v1Parsed] = openControlWraps([v1], [control]);
    // "The list replaces entire" was the lever: a moderator republishing it
    // without the admin dropped a ban they could never have issued.
    wraps.push(
      v1,
      await sealEdition(
        buildBanlistEdition(communityId, [outsider.pubkey], {
          actorPubkey: mod.pubkey,
          version: 2n,
          prevHash: v1Parsed.selfHash,
          authority: citeGrant(modGrant, control),
        }),
        control,
        mod,
      ),
    );

    const folded = foldControlState(openControlWraps(wraps, [control]), communityId, owner.pubkey);
    expect(folded.banned.has(admin.pubkey)).toBe(true); // carried over, outside the mod's reach
    expect(folded.banned.has(outsider.pubkey)).toBe(true); // their own entry stands
  });

  it("the owner can still lift any ban, and a mod can lift one they issued", async () => {
    const { owner, communityId, control, mod, modGrant, wraps } = await staffedCommunity();
    const outsider = signer();

    const v1 = await sealEdition(
      buildBanlistEdition(communityId, [outsider.pubkey], {
        actorPubkey: mod.pubkey,
        version: 1n,
        authority: citeGrant(modGrant, control),
      }),
      control,
      mod,
    );
    const [v1Parsed] = openControlWraps([v1], [control]);
    wraps.push(
      v1,
      await sealEdition(
        buildBanlistEdition(communityId, [], { actorPubkey: owner.pubkey, version: 2n, prevHash: v1Parsed.selfHash }),
        control,
        owner,
      ),
    );

    const folded = foldControlState(openControlWraps(wraps, [control]), communityId, owner.pubkey);
    expect(folded.banned.size).toBe(0);
  });

  it("an equal-version fork cannot evict the owner's ban by grinding its rumor id", async () => {
    const { owner, communityId, control, mod, modGrant, wraps } = await staffedCommunity();
    const outsider = signer();

    // Both siblings are authorized and both link to nothing, so the chain
    // cannot separate them: the tiebreak is all there is, and the id half of
    // it is ground until it sorts first.
    let real: NostrEvent | undefined;
    let forged: NostrEvent | undefined;
    let t = 1_800_000_000;
    outer: for (;;) {
      const realWrap = await sealEdition(
        buildBanlistEdition(communityId, [outsider.pubkey], { actorPubkey: owner.pubkey, version: 1n, createdAtSecs: t++ }) as Rumor,
        control,
        owner,
      );
      const [realP] = openControlWraps([realWrap], [control]);
      for (let i = 0; i < 8; i++) {
        const forgedWrap = await sealEdition(
          buildBanlistEdition(communityId, [], {
            actorPubkey: mod.pubkey,
            version: 1n,
            createdAtSecs: t++,
            authority: citeGrant(modGrant, control),
          }) as Rumor,
          control,
          mod,
        );
        const [forgedP] = openControlWraps([forgedWrap], [control]);
        if (bytesToHex(forgedP.rumorId) < bytesToHex(realP.rumorId)) {
          real = realWrap;
          forged = forgedWrap;
          break outer;
        }
      }
    }

    wraps.push(real!, forged!);
    const folded = foldControlState(openControlWraps(wraps, [control]), communityId, owner.pubkey);
    expect(folded.banned.has(outsider.pubkey)).toBe(true);
  });

  // The banlist was not the only entity whose equal-version tie fell to the
  // grindable rumor id; the fix is in `pickHead`, shared by every gated entity.
  it("an equal-version metadata fork cannot grind out the owner's edition", async () => {
    const { owner, communityId, control, admin, admGrant, wraps } = await staffedCommunity();

    let real: NostrEvent | undefined;
    let forged: NostrEvent | undefined;
    let t = 1_800_000_000;
    outer: for (;;) {
      const realWrap = await sealEdition(
        buildMetadataEdition(communityId, { name: "Real", relays: [] }, { actorPubkey: owner.pubkey, version: 1n, createdAtSecs: t++ }) as Rumor,
        control,
        owner,
      );
      const [realP] = openControlWraps([realWrap], [control]);
      for (let i = 0; i < 8; i++) {
        const forgedWrap = await sealEdition(
          buildMetadataEdition(communityId, { name: "Hijacked", relays: [] }, {
            actorPubkey: admin.pubkey,
            version: 1n,
            createdAtSecs: t++,
            authority: citeGrant(admGrant, control),
          }) as Rumor,
          control,
          admin,
        );
        const [forgedP] = openControlWraps([forgedWrap], [control]);
        if (bytesToHex(forgedP.rumorId) < bytesToHex(realP.rumorId)) {
          real = realWrap;
          forged = forgedWrap;
          break outer;
        }
      }
    }

    wraps.push(real!, forged!);
    const folded = foldControlState(openControlWraps(wraps, [control]), communityId, owner.pubkey);
    expect(folded.metadata?.name).toBe("Real");
  });
});
