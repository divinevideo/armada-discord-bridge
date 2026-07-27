/**
 * Headless Concord client: everything the bridge needs to be a community
 * member. Join from an invite, fold the Control Plane, and publish chat
 * rumors signed by any local identity (primary or puppet).
 *
 * Loop prevention layer 1 lives here: every rumor the bridge publishes
 * carries a `proxy` tag naming its Discord origin, and the router refuses to
 * bridge any incoming rumor that has one.
 */

import {
  KIND_INVITE_BUNDLE,
  KIND_MESSAGE,
  KIND_SEAL_ENCRYPTED,
  KIND_WRAP,
  Permissions,
  buildJoinRumor,
  buildRumor,
  bundleToEntry,
  channelBindingTags,
  channelsView,
  controlGroups,
  currentGuestbookGroup,
  foldControlState,
  guestbookGroups,
  inviteRefOf,
  isAuthorized,
  openChatBatch,
  openControlWraps,
  parseBundleEvent,
  parseInviteLink,
  registerStreamKeys,
  rehydrateCommunity,
  sealGuestbook,
  sealRumor,
  validateBundle,
  wrapSeal,
} from "@armada-bridge/concord-core";
import type {
  ChannelV2,
  CommunityListEntry,
  CommunityV2,
  FoldedControl,
  InviteBundle,
  OpenedChat,
  Rumor,
} from "@armada-bridge/concord-core";
import type { NostrEvent } from "nostr-tools/pure";

import type { RelayLike } from "./pool";
import type { LocalIdentity } from "./signer";

/** Tag stamped on every bridge-published rumor: ["proxy", <discord id>, "discord"]. */
export const TAG_PROXY = "proxy";

export function proxyTag(discordMessageId: string): string[] {
  return [TAG_PROXY, discordMessageId, "discord"];
}

/** True when a rumor was published by any bridge (ours or a peer's). */
export function hasProxyTag(rumor: { tags: string[][] }): boolean {
  return rumor.tags.some((tag) => tag[0] === TAG_PROXY);
}

export interface JoinResult {
  entry: CommunityListEntry;
  community: CommunityV2;
  bundle: InviteBundle;
}

/**
 * Resolve an Armada invite URL into join material: fetch the kind 33301
 * bundle from the pool, decrypt with the fragment token, validate the
 * self-certifying community id, and rehydrate the community.
 */
export async function resolveInvite(inviteUrl: string, pool: RelayLike): Promise<JoinResult> {
  const invite = parseInviteLink(inviteUrl);
  if (!invite) throw new Error("not a valid Armada invite URL");

  const events = await pool.query([
    { kinds: [KIND_INVITE_BUNDLE], authors: [invite.linkSigner], limit: 8 },
  ]);
  const newest = events.sort((a, b) => b.created_at - a.created_at)[0];
  if (!newest) throw new Error("invite bundle not found on bootstrap relays");

  const bundle = validateBundle(parseBundleEvent(newest, invite.linkSigner, invite.token, Date.now()));
  if (bundle.expires_at && Date.now() > bundle.expires_at) {
    throw new Error("invite link has expired");
  }

  const entry = bundleToEntry(bundle, { inviteRef: inviteRefOf(invite) });
  const community = rehydrateCommunity(entry);
  if (!community) throw new Error("bundle failed community id verification");
  return { entry, community, bundle };
}

export interface SendChatOptions {
  content: string;
  /** The signing identity; a puppet for bridged Discord users. */
  author: LocalIdentity;
  /** Rumor kind; defaults to kind 9 chat message. */
  kind?: number;
  /** Extra tags (proxy tag, q/reply tags, imeta, ...). */
  tags?: string[][];
  /** Send time in epoch ms; defaults to now. */
  ms?: number;
}

export class ConcordClient {
  folded?: FoldedControl;

  /** The bridge's own posting identity; the router skips its messages. */
  get primaryPk(): string {
    return this.primary.pk;
  }

  constructor(
    readonly community: CommunityV2,
    private readonly pool: RelayLike,
    private readonly primary: LocalIdentity,
  ) {
    // NIP-42-gated relays require AUTH as every queried stream author; the
    // pool signs challenges with whatever is registered here (streamAuth).
    registerStreamKeys(
      [...controlGroups(community), ...guestbookGroups(community)],
      community.relays,
    );
  }

  /** Fetch and fold the Control Plane (channels, roles, banlist). */
  async syncControl(opts?: { signal?: AbortSignal }): Promise<FoldedControl> {
    const groups = controlGroups(this.community);
    const wraps = await this.pool.query(
      [{ kinds: [KIND_WRAP], authors: groups.map((g) => g.pk) }],
      opts,
    );
    const editions = openControlWraps(wraps, groups);
    this.folded = foldControlState(editions, this.community.id, this.community.owner);
    return this.folded;
  }

  /** Channels readable with held keys, per the current fold. */
  channels(): ChannelV2[] {
    const channels = channelsView(this.community, this.folded);
    registerStreamKeys(
      channels.flatMap((c) => c.streams.map((s) => s.group)),
      this.community.relays,
    );
    return channels;
  }

  channel(idHex: string): ChannelV2 | undefined {
    return this.channels().find((c) => c.idHex === idHex);
  }

  /** Honest clients drop banned authors; the bridge must never publish for them. */
  isBanned(pubkeyHex: string): boolean {
    return this.folded?.banned.has(pubkeyHex) ?? false;
  }

  /** MANAGE_MESSAGES holder (or owner) per the current fold. */
  isModerator(pubkeyHex: string): boolean {
    if (!this.folded) return false;
    return isAuthorized(this.folded.roster, pubkeyHex, this.community.owner, Permissions.MANAGE_MESSAGES);
  }

  /**
   * Publish a kind 0 profile for an identity (puppets: Discord name +
   * avatar). Plain unwrapped event; Armada resolves member profiles from
   * the same relays the community lives on.
   */
  async publishProfile(
    author: LocalIdentity,
    meta: { name: string; picture?: string; about?: string; bot?: boolean },
  ): Promise<void> {
    const event = await author.signer.signEvent({
      kind: 0,
      content: JSON.stringify(meta),
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
    });
    await this.pool.publish(event);
  }

  /** Publish the primary identity's Guestbook join (kind 3306). */
  async publishJoin(ms = Date.now()): Promise<NostrEvent> {
    const group = currentGuestbookGroup(this.community);
    const rumor = buildJoinRumor(this.primary.pk, ms);
    // sealGuestbook signs the encrypted seal AND wraps it in one step.
    const wrap = await sealGuestbook(rumor, group, this.primary.signer);
    await this.pool.publish(wrap);
    return wrap;
  }

  /**
   * Live-stream a channel's chat: standing REQ across every held epoch's
   * stream address, opened and binding-checked, deduped by rumor id.
   */
  subscribeChannel(channel: ChannelV2, onChat: (chat: OpenedChat) => void): () => void {
    const seenRumors = new Set<string>();
    return this.pool.subscribe(
      [{ kinds: [KIND_WRAP], authors: channel.streams.map((s) => s.group.pk) }],
      {
        onEvent: (wrap) => {
          void openChatBatch([wrap], channel).then((opened) => {
            for (const chat of opened) {
              if (seenRumors.has(chat.rumorId)) continue;
              if (seenRumors.size >= 65_536) seenRumors.clear();
              seenRumors.add(chat.rumorId);
              onChat(chat);
            }
          });
        },
      },
    );
  }

  /**
   * Live-fold the Control Plane: each incoming control wrap re-folds the
   * accumulated edition set (control history is small by design; the fold
   * itself is memoized in core). Keeps `this.folded` current so bans and
   * channel changes apply to the very next send.
   */
  subscribeControl(onFold?: (folded: FoldedControl) => void): () => void {
    const groups = controlGroups(this.community);
    const wraps: NostrEvent[] = [];
    const seen = new Set<string>();
    return this.pool.subscribe(
      [{ kinds: [KIND_WRAP], authors: groups.map((g) => g.pk) }],
      {
        onEvent: (wrap) => {
          if (seen.has(wrap.id)) return;
          seen.add(wrap.id);
          wraps.push(wrap);
          const editions = openControlWraps(wraps, groups);
          this.folded = foldControlState(editions, this.community.id, this.community.owner);
          onFold?.(this.folded);
        },
      },
    );
  }

  /**
   * Publish a chat rumor into a channel: binding tags, author-signed seal,
   * stream-signed wrap, any-accept broadcast. Returns both layers so the
   * caller can persist the rumor id mapping.
   */
  async sendChat(channel: ChannelV2, opts: SendChatOptions): Promise<{ rumor: Rumor; wrap: NostrEvent }> {
    if (this.isBanned(opts.author.pk)) {
      throw new Error(`author ${opts.author.pk} is banned in this community`);
    }
    const rumor = buildRumor({
      kind: opts.kind ?? KIND_MESSAGE,
      content: opts.content,
      pubkey: opts.author.pk,
      ms: opts.ms ?? Date.now(),
      tags: [...channelBindingTags(channel.idHex, channel.current.epoch), ...(opts.tags ?? [])],
    });
    const seal = await sealRumor(rumor, KIND_SEAL_ENCRYPTED, channel.current.group, opts.author.signer);
    const wrap = wrapSeal(seal, channel.current.group);
    await this.pool.publish(wrap);
    return { rumor, wrap };
  }
}
