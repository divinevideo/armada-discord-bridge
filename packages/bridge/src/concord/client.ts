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
  KIND_BOT_MANIFEST,
  KIND_DM_RELAYS,
  KIND_INVITE_BUNDLE,
  KIND_MESSAGE,
  KIND_SEAL_ENCRYPTED,
  KIND_TYPING,
  KIND_WRAP,
  KIND_WRAP_EPHEMERAL,
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

/**
 * NIP-48 tag stamped on every bridge-published rumor:
 * ["proxy", <discord permalink>, "web"]. The full URL keeps the origin
 * clickable in any client that surfaces proxy tags.
 */
export const TAG_PROXY = "proxy";

export function proxyTag(guildId: string, channelId: string, messageId: string): string[] {
  return [TAG_PROXY, `https://discord.com/channels/${guildId}/${channelId}/${messageId}`, "web"];
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

  /**
   * Publish a Guestbook join (kind 3306) for an identity: the primary by
   * default, or a puppet so bridged Discord users appear in the member list
   * before they are looked up by a message.
   */
  /**
   * Publish the NIP-17 DM relay list (kind 10050) — where our giftwrap inbox
   * lives, and so where a Direct Invite carrying a private-channel key gets
   * delivered (`recipientInboxRelays`). Replaceable; boot republish is the
   * update mechanism.
   *
   * The community relays are the honest answer for a bridge: it is only ever
   * reachable about one community, and it already holds standing connections
   * to exactly those relays.
   */
  async publishDmRelays(author: LocalIdentity, relays: string[]): Promise<void> {
    const event = await author.signer.signEvent({
      kind: KIND_DM_RELAYS,
      content: "",
      tags: relays.map((url) => ["relay", url]),
      created_at: Math.floor(Date.now() / 1000),
    });
    await this.pool.publish(event);
  }

  async publishJoin(ms = Date.now(), author: LocalIdentity = this.primary): Promise<NostrEvent> {
    const group = currentGuestbookGroup(this.community);
    const rumor = buildJoinRumor(author.pk, ms);
    // sealGuestbook signs the encrypted seal AND wraps it in one step.
    const wrap = await sealGuestbook(rumor, group, author.signer);
    await this.pool.publish(wrap);
    return wrap;
  }

  /**
   * Publish the primary identity's kind 10304 command manifest (Armada's
   * draft bot NIP). Replaceable: each publish supersedes the last, so boot
   * republish is the update mechanism.
   */
  async publishManifest(
    commands: Array<{
      name: string;
      description: string;
      args?: Array<{
        name: string;
        type: string;
        description?: string;
        required?: boolean;
        choices?: string[];
      }>;
    }>,
  ): Promise<void> {
    const event = await this.primary.signer.signEvent({
      kind: KIND_BOT_MANIFEST,
      content: JSON.stringify({
        v: 1,
        commands: commands.map((c) => ({
          name: c.name,
          description: c.description,
          args: (c.args ?? []).map((a) => ({
            name: a.name,
            type: a.type,
            description: a.description ?? "",
            required: a.required ?? false,
            ...(a.choices ? { choices: a.choices } : {}),
          })),
        })),
      }),
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
    });
    await this.pool.publish(event);
  }

  /**
   * Publish an ephemeral typing signal (kind 23311 in a 21059 wrap) into a
   * channel. Relays never store it; failure is not worth surfacing.
   */
  async sendTyping(channel: ChannelV2, author: LocalIdentity, ms = Date.now()): Promise<void> {
    const rumor = buildRumor({
      kind: KIND_TYPING,
      content: "",
      pubkey: author.pk,
      ms,
      tags: channelBindingTags(channel.idHex, channel.current.epoch),
    });
    const seal = await sealRumor(rumor, KIND_SEAL_ENCRYPTED, channel.current.group, author.signer);
    const wrap = wrapSeal(seal, channel.current.group, { ephemeral: true });
    await this.pool.publish(wrap);
  }

  /**
   * Live-stream a channel's chat: standing REQ across every held epoch's
   * stream address, opened and binding-checked, deduped by rumor id.
   */
  subscribeChannel(
    channel: ChannelV2,
    onChat: (chat: OpenedChat) => void,
    onError?: (relayUrl: string, error: unknown) => void,
    /** Called per durable wrap that opened; feeds the catch-up cursor. */
    onCursor?: (streamPk: string, wrapCreatedAt: number) => void,
  ): () => void {
    const seenRumors = new Set<string>();
    // Live tail only: without a floor, relays replay stored history into the
    // router on every (re)subscribe. Catch-up after downtime is cursor work,
    // not replay-everything. Small overlap absorbs clock skew.
    const since = Math.floor(Date.now() / 1000) - 60;
    return this.pool.subscribe(
      // Both wrap kinds: 1059 durable chat and 21059 ephemeral (typing).
      [
        {
          kinds: [KIND_WRAP, KIND_WRAP_EPHEMERAL],
          authors: channel.streams.map((s) => s.group.pk),
          since,
        },
      ],
      {
        onError,
        onEvent: (wrap) => {
          void openChatBatch([wrap], channel).then((opened) => {
            for (const chat of opened) {
              if (seenRumors.has(chat.rumorId)) continue;
              if (seenRumors.size >= 65_536) seenRumors.clear();
              seenRumors.add(chat.rumorId);
              onChat(chat);
            }
            if (opened.length > 0 && wrap.kind === KIND_WRAP) {
              onCursor?.(wrap.pubkey, wrap.created_at);
            }
          });
        },
      },
    );
  }

  /**
   * Bounded catch-up: every durable wrap on the channel's streams newer than
   * `sinceSec`, opened and sorted oldest-first so the caller can replay them
   * through the router in order (the mapping table dedupes already-mirrored
   * rumors). Returns the chats and the newest wrap timestamp seen, the next
   * cursor value.
   */
  async backfillChannel(
    channel: ChannelV2,
    sinceSec: number,
    limit = 500,
    opts?: { signal?: AbortSignal },
  ): Promise<{ chats: OpenedChat[]; newestWrapAt?: number }> {
    const wraps = await this.pool.query(
      [
        {
          kinds: [KIND_WRAP],
          authors: channel.streams.map((s) => s.group.pk),
          since: sinceSec,
          limit,
        },
      ],
      opts,
    );
    const chats = await openChatBatch(wraps, channel);
    chats.sort((a, b) => a.ms - b.ms);
    const newestWrapAt = wraps.reduce<number | undefined>(
      (max, w) => (max === undefined || w.created_at > max ? w.created_at : max),
      undefined,
    );
    return { chats, newestWrapAt };
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
