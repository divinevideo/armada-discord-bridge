/**
 * Severance detection: the three ways a bridged community cuts the bridge off
 * — ban, refounding, dissolution — classified from raw relay evidence by the
 * SAME primitives the protocol kernel folds. No parallel parser lives here:
 * wraps open through `openWrap`, rotations through `parseRekey`/
 * `groupRotations`, tombstones through `isDissolved`, authority through the
 * fold's own gates, so this module can never drift from what Armada accepts.
 *
 * The cases, in protocol terms (all three end with the bridge's keys no longer
 * being worth forwarding with):
 *
 *   ban — the Control Plane Banlist (`buildBanlistEdition`, folded into
 *     `FoldedControl.banned`/`bannedAt`, CORD-04 §4) names the bridging
 *     identity (the bridge's primary npub). Every other "the community refuses
 *     the bridge's keys" surface follows from that one signed fact: the
 *     Guestbook fold drops the identity's entries, `sendChat` refuses its
 *     rumors, and a ban→Refounding (below) then carries the post-removal
 *     secrecy. A relay refusing a publish is deliberately NOT read as a ban —
 *     from one attempt it is indistinguishable from a relay outage (the same
 *     reasoning as START_FAILURE_SEVER_AFTER_MS), while the Banlist is the
 *     community's actual refusal: signed, folded, and named.
 *
 *   refounding — the root epoch advanced (CORD-06): a new `refounder` minted a
 *     new held root, so the keys and stream addresses the bridge holds belong
 *     to a retired epoch (`HeldRoot.retiredAt` is that epoch's hard read
 *     cutoff — writes sealed under it after the rotation are refused by every
 *     honest reader). The evidence is the base rotation itself: a COMPLETE,
 *     continuity-valid, authorized Refounding minted FROM the root the bridge
 *     holds (rekey.ts — a missing chunk is never read as a rotation). Its
 *     per-recipient blobs then say which side of it the bridge is on: carried
 *     forward (resume adopts the refreshed invite at the new epoch) or
 *     excluded (the kick/ban Refounding that carried no blob — the
 *     `excluded_at_epoch` case in communityList.ts).
 *
 *   dissolution — the owner published the dissolution tombstone at the
 *     dissolved plane (CORD-02 §9, `isDissolved`): the community is gone, and
 *     there is no un-dissolve. The member-side mirror of the same event is a
 *     Community List tombstone (`removeFromList`); the bridge's durable mirror
 *     is `communities.severed_reason`.
 *
 * Pure and additive. The caller gathers evidence (a boot query plus standing
 * subscriptions over `severanceStreamKeys` — see the bridge client) and the
 * folded control state, and this module classifies it. Nothing here changes
 * which editions are admissible: the Refounding gate is exactly the one
 * rekeyRecovery.ts already applies to key adoption, so the bridge and the
 * moderation worker can never disagree about who may mint a rotation.
 */

import type { NostrEvent } from "nostr-tools/pure";
import {
  Permissions,
  ROOT_SCOPE_HEX,
  baseRekeyGroupKey,
  checkContinuity,
  citationSatisfied,
  dissolvedGroupKey,
  findBlob,
  groupRotations,
  isAuthorized,
  isDissolved,
  myLocator,
  openWrap,
  parseRekey,
  rotationExcludesMe,
  rotationPublishedAtMs,
  type AuthorityCitation,
  type CommunityV2,
  type FoldedControl,
  type StreamKeyView,
} from "@armada-bridge/concord-core";

import { baseRekeyWatchKeys } from "@armada-bridge/bridge/src/concord/client";

/**
 * Why the bridge stopped, in the exact vocabulary `schema.sql` reserves for
 * `communities.severed_reason`. One column, one word per case.
 */
export type SeveranceReason = "banned" | "refounded" | "dissolved";

export type SeveranceVerdict =
  | {
      reason: "banned";
      /** The bridged identity the Banlist names. */
      pubkey: string;
      /** When the ban landed (ms), when the fold recorded it. */
      bannedAtMs?: number;
    }
  | {
      reason: "refounded";
      /** The epoch the Refounding minted (the bridge's keys are superseded). */
      newEpoch: bigint;
      /** The npub whose Refounding it was (the new `refounder`). */
      refounder: string;
      /** When the rotation published (ms) — the newest of its chunks. */
      rotatedAtMs: number;
      /** Whether the rotation carried a blob for this bridge (carried forward). */
      carried: boolean;
      /**
       * Whether the rotation EXCLUDED this bridge — no blob, and published
       * after the membership began (`rotationExcludesMe`). A rotation that
       * predates the join leaves the bridge stranded on a stale bundle, which
       * is not a removal.
       */
      excluded: boolean;
    }
  | { reason: "dissolved" };

/** The folded state the detectors read (all of {@link FoldedControl} works). */
export type SeveranceFold = Pick<FoldedControl, "banned" | "bannedAt" | "roster" | "heads" | "ownerHex">;

export interface SeveranceInput {
  /**
   * Every wrap fetched from the severance planes (`severanceStreamKeys`):
   * base-rekey rotations and the dissolved tombstone travel as the same kind
   * (1059) and are routed by their stream address.
   */
  wraps: readonly NostrEvent[];
  /** The community as the bridge holds it (root, rootEpoch, owner, id). */
  community: CommunityV2;
  /** The bridging identity — the bridge's primary npub. */
  me: string;
  /** The folded Control Plane: the ban surface and the Refounding gate. */
  folded?: SeveranceFold;
  /**
   * When this membership began (ms) — `communities.joined_at` /
   * `bridges.created_at`. Sharpens the exclusion reading only: a rotation that
   * entirely predates the join can strand on a stale bundle but cannot have
   * removed a member who did not exist yet (`rotationExcludesMe`).
   */
  joinedAtMs?: number;
}

/**
 * Whether `me` is banned by the community's control plane (case 1).
 *
 * Only the bridged identity counts. A ban naming a puppet is ordinary per-user
 * moderation — `sendChat` already refuses that user's rumors — and cutting the
 * whole link over one banned Discord user would hand any community a lever
 * over unrelated conversations. The bridge's own npub is the identity that
 * joins, confirms and announces; its ban is the community refusing the bridge.
 */
export function detectBan(
  folded: Pick<FoldedControl, "banned" | "bannedAt"> | undefined,
  me: string,
): Extract<SeveranceVerdict, { reason: "banned" }> | undefined {
  if (!folded?.banned.has(me)) return undefined;
  // `bannedAt` records the banlist edition's created_at in SECONDS (it feeds
  // `completeMemberlist`'s pre-ban staleness check, which compares in seconds).
  const at = folded.bannedAt.get(me);
  return {
    reason: "banned",
    pubkey: me,
    ...(typeof at === "number" ? { bannedAtMs: at * 1000 } : {}),
  };
}

/**
 * The Refounding authority gate, the same three checks rekeyRecovery.ts applies
 * before adopting a rotation's key material (its `verifyRecoveredRoot`): the
 * rotator is un-banned, holds BAN (a Refounding is the ban→post-removal-
 * secrecy flow, CORD-06), and cites a Grant the fold can confirm. Duplicating
 * that gate's SHAPE is the point — inventing a looser one here would let the
 * bridge sever on a rotation the moderation worker (and Armada) refuse, and a
 * stranger's griefing rotation would cut every link in the community.
 */
export function refoundGate(
  folded: SeveranceFold,
  community: CommunityV2,
): (rotator: string, authority: AuthorityCitation | undefined) => boolean {
  return (rotator, authority) =>
    !folded.banned.has(rotator) &&
    isAuthorized(folded.roster, rotator, community.owner, Permissions.BAN) &&
    citationSatisfied(folded, community.id, rotator, authority);
}

/** Every chunk of one rotation must cite the same Grant (rekeyRecovery). */
function disagreeingAuthority(
  chunks: Iterable<{ authority?: AuthorityCitation }>,
  authority: AuthorityCitation | undefined,
): boolean {
  const canonical = (c: AuthorityCitation | undefined) =>
    JSON.stringify(c, (_, value) => (typeof value === "bigint" ? value.toString() : value));
  const want = canonical(authority);
  for (const chunk of chunks) if (canonical(chunk.authority) !== want) return true;
  return false;
}

/**
 * Whether the community Refounded past the epoch this bridge holds (case 2).
 *
 * The evidence is a base rotation chained off the CURRENT root: complete (all
 * chunks), continuity-valid at the held (epoch, root), and minted by someone
 * allowed to mint one. Anything less is not a Refounding the bridge may act
 * on — see the negatives this is built to fail: an impostor's rotation at the
 * (member-derivable) rekey address, a half-published rotation, a rotation
 * replacing an epoch above ours (we missed one — a gap, not a verdict).
 *
 * The verdict does NOT adopt the rotation's key material. The bridge re-keys
 * the honest way — re-resolving its invite, whose bundle is refreshed in place
 * at every rotation (CORD-05 §2/§3) — so a forged key can never land here; the
 * rotation is read only for the fact of the Refounding and its blobs' shape.
 */
export function detectRefounding(
  input: SeveranceInput & { canRefound?: (rotator: string, authority: AuthorityCitation | undefined, atMs: number) => boolean },
): Extract<SeveranceVerdict, { reason: "refounded" }> | undefined {
  const groups = new Map<string, StreamKeyView>();
  for (const key of baseRekeyWatchKeys(input.community)) groups.set(key.pk, key);

  const parsed = [];
  for (const wrap of input.wraps) {
    const group = groups.get(wrap.pubkey);
    if (!group) continue;
    try {
      parsed.push(parseRekey(openWrap(wrap, group)));
    } catch {
      // Unrelated or malformed candidates are not rotations.
    }
  }

  const gate =
    input.canRefound ??
    (input.folded
      ? refoundGate(input.folded, input.community)
      : (rotator: string) => rotator === input.community.owner);

  const candidates: Array<{
    newEpoch: bigint;
    refounder: string;
    rotatedAtMs: number;
    carried: boolean;
    excluded: boolean;
  }> = [];
  for (const rotation of groupRotations(parsed)) {
    if (!rotation.complete) continue; // a missing chunk is never a removal
    if (rotation.scopeIdHex !== ROOT_SCOPE_HEX) continue;
    if (rotation.newEpoch <= input.community.rootEpoch) continue;
    if (!checkContinuity(rotation, input.community.rootEpoch, input.community.root).ok) continue;
    const rotatedAtMs = rotationPublishedAtMs(rotation);
    if (!gate(rotation.rotator, rotation.authority, rotatedAtMs)) continue;
    if (disagreeingAuthority(rotation.chunks.values(), rotation.authority)) continue;

    const carried =
      findBlob(rotation, myLocator(rotation.rotator, input.me, ROOT_SCOPE_HEX, rotation.newEpoch)) !== undefined;
    const excluded =
      !carried &&
      input.joinedAtMs !== undefined &&
      rotationExcludesMe(rotatedAtMs, input.joinedAtMs);
    candidates.push({
      newEpoch: rotation.newEpoch,
      refounder: rotation.rotator,
      rotatedAtMs,
      carried,
      excluded,
    });
  }
  if (candidates.length === 0) return undefined;

  // Several rotations can correlate at one continuity point (CORD-06 §3 race
  // convergence). The fork carrying this bridge's blob is the one that kept it
  // — the others' exclusion readings are noise — and failing that, the lowest
  // epoch is the one that actually displaced the keys we hold.
  candidates.sort((a, b) => {
    if (a.carried !== b.carried) return a.carried ? -1 : 1;
    return a.newEpoch < b.newEpoch ? -1 : a.newEpoch > b.newEpoch ? 1 : 0;
  });
  const win = candidates[0];
  return { reason: "refounded", ...win };
}

/**
 * Whether the owner dissolved this community (case 3). Terminal: on sight the
 * community is gone — the tombstone is owner-signed at an address derived from
 * the community_id alone (so every member past or present resolves it), and
 * `isDissolved` refuses impostor seals and replayed tombstones (CORD-02 §9).
 */
export function detectDissolved(
  input: Pick<SeveranceInput, "wraps" | "community">,
): Extract<SeveranceVerdict, { reason: "dissolved" }> | undefined {
  // Derived from the community_id alone (CORD-02 §9) — every past or present
  // member resolves it, which is what makes the tombstone findable at all.
  const planePk = dissolvedGroupKey(input.community.id).pk;
  const onPlane = input.wraps.filter((w) => w.pubkey === planePk);
  return onPlane.length > 0 && isDissolved(onPlane, input.community.id, input.community.owner)
    ? { reason: "dissolved" }
    : undefined;
}

/**
 * Classify every severance surface at once, terminal truth first. A
 * dissolution outranks everything (the community is gone, so whatever else the
 * evidence says is about a world that no longer exists), and a ban outranks
 * the Refounding it usually rides: ban→refound is one flow, and the ban is the
 * reason, the rotation only its secrecy mechanism. The verdict must name WHY
 * the bridge stopped, not merely that it did — that is what the operator's
 * dashboard reads.
 */
export function detectSeverance(input: SeveranceInput): SeveranceVerdict | undefined {
  return (
    detectDissolved(input) ??
    detectBan(input.folded, input.me) ??
    detectRefounding(input)
  );
}

/**
 * The operator-facing `status_detail` for a verdict. The recovery half is the
 * contract the resume path implements: start() re-resolves the stored invite,
 * whose bundle carries the CURRENT epoch (CORD-05 §2/§3), so a resume either
 * adopts the new keys or discovers the link no longer vends them.
 */
export function severanceDetail(verdict: SeveranceVerdict): string {
  switch (verdict.reason) {
    case "banned":
      return "the community's control plane has banned this bridge's identity; forwarding stopped";
    case "dissolved":
      return "the community was dissolved by its owner; there is nothing left to bridge";
    case "refounded":
      if (verdict.excluded) {
        return (
          `the community refounded at epoch ${verdict.newEpoch} and excluded this bridge; ` +
          `resume re-resolves the refreshed invite and adopts it only if the link still vends keys`
        );
      }
      if (verdict.carried) {
        return (
          `the community refounded at epoch ${verdict.newEpoch}; this bridge's keys are superseded — ` +
          `resume re-resolves the refreshed invite and adopts the new epoch`
        );
      }
      return (
        `the community refounded at epoch ${verdict.newEpoch} before this bridge joined; ` +
        `this bridge holds keys for a superseded epoch — resume re-resolves the refreshed invite`
      );
  }
}
