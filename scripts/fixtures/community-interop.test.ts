import { expect, test } from 'bun:test';
import { citationFromTags, InviteError, parseBundleEvent, parseInviteLink, bytesToHex, canActOnMember, channelsView, citationSatisfied, controlGroups, foldTimeline, isAuthorized, openChatBatch, openControlWraps, openWrap, Permissions } from '@armada-bridge/concord-core';
import fixture from '../../test-fixtures/concord/community-interop.json';
import { bootstrapFixture, projectChannel } from './community-bootstrap';

test('shared client fixture resolves real public channels', async () => {
  const { community, folded } = bootstrapFixture(fixture);
  expect(community.idHex).toBe(fixture.expected.communityId);
  expect(community.controlRoot).toBeUndefined();
  expect(folded.incomplete).toEqual([]);
  const channels = channelsView(community, folded);
  expect(channels.map(projectChannel)).toEqual(fixture.expected.channels);
  expect(channels.map(c => c.name).sort()).toEqual(['general', 'introductions']);
  expect(folded.banned.has(fixture.expected.bannedMember)).toBe(true);
  const channel = channels.find(c => c.idHex === fixture.expected.message.channelId)!;
  // The read path every client uses, not a bare openWrap: it also refuses a
  // plaintext seal and a carrier bound to another channel or epoch.
  const opened = await openChatBatch([fixture.chatEvent], channel);
  expect(opened).toHaveLength(1);
  expect(opened[0].rumorId).toBe(fixture.expected.message.id);
  expect(opened[0].content).toBe(fixture.expected.message.content);
  expect(opened[0].author).toBe(fixture.expected.member);
  // Each negative opens with a bare openWrap, so only those read-path checks
  // keep them out; a client that skips any one of them admits a carrier.
  const negatives = [fixture.plaintextChatEvent, fixture.misboundChatEvent, fixture.epochMisboundChatEvent];
  for (const carrier of negatives) expect(openWrap(carrier, channel.current.group).author).toBe(fixture.expected.member);
  expect(await openChatBatch(negatives, channel)).toEqual([]);
});

test('the shared invite is live and a revoked one never opens', () => {
  const { invite, folded } = bootstrapFixture(fixture);
  // Decrypting a bundle is not the same as its link being live: liveness is
  // the link signer appearing in the owner's folded invite registry.
  expect(folded.liveInviteLinks.has(invite.linkSigner)).toBe(true);
  const revoked = parseInviteLink(fixture.revokedInviteUrl)!;
  // The link was real: the live bundle the revocation replaced opens with the
  // URL's token. The tombstone is the newer event at the same coordinate, so it
  // is what a client must act on, and it must refuse for the stated reason.
  expect(parseBundleEvent(fixture.revokedLiveBundleEvent, revoked.linkSigner, revoked.token, Date.now()).community_id).toBe(fixture.expected.communityId);
  expect(fixture.revokedBundleEvent.created_at).toBeGreaterThan(fixture.revokedLiveBundleEvent.created_at);
  let refusal: unknown;
  try { parseBundleEvent(fixture.revokedBundleEvent, revoked.linkSigner, revoked.token, Date.now()); } catch (e) { refusal = e; }
  expect(refusal).toBeInstanceOf(InviteError);
  expect((refusal as InviteError).code).toBe('revoked');
});

test('a rename that skips the chain is held back as incomplete, whoever signed it', () => {
  // rejectedControlEvents is a data-availability vector, not an authority one.
  // Its v2 names no previous edition, so the fold cannot link it to the v1 it
  // holds and reports the channel incomplete. An owner-signed v2 built the same
  // way is refused identically, so this says nothing about who may rename. And
  // `incomplete` is not an authorization signal: FoldedControl deliberately
  // leaves authority-rejected entities out of it, so an unauthorized edition
  // that does chain is refused with `incomplete` empty.
  const { community, fold } = bootstrapFixture(fixture);
  const gapped = fold([...fixture.controlEvents, ...fixture.rejectedControlEvents]);
  expect(gapped.incomplete).toEqual([fixture.expected.message.channelId]);
  expect(channelsView(community, gapped).map(c => c.name)).not.toContain('changed');
});

test('a rename by staff without MANAGE_CHANNELS changes nothing, though it chains and cites', () => {
  const { community, folded, fold } = bootstrapFixture(fixture);
  const channelId = fixture.expected.message.channelId;
  const head = folded.heads.get(channelId)!;
  // Every other reason to refuse it is ruled out first: it links to the
  // accepted head and cites the signer's own current Grant. Only the
  // permission is missing, so a client that checks anything less than
  // MANAGE_CHANNELS on the fold's roster applies this rename.
  const [forged] = openControlWraps(fixture.unauthorizedControlEvents, controlGroups(community));
  expect(forged.author).toBe(fixture.expected.moderator);
  expect(forged.version).toBe(head.version + 1n);
  expect(bytesToHex(forged.prevHash!)).toBe(bytesToHex(head.hash));
  expect(citationSatisfied(folded, community.id, forged.author, forged.authority)).toBe(true);
  expect(isAuthorized(folded.roster, forged.author, community.owner, Permissions.MANAGE_CHANNELS)).toBe(false);
  const refused = fold([...fixture.controlEvents, ...fixture.unauthorizedControlEvents]);
  // Refused for authority, so not reported as a data-availability gap.
  expect(refused.incomplete).toEqual([]);
  expect(refused.heads.get(channelId)).toEqual(head);
  expect(channelsView(community, refused).find(c => c.idHex === channelId)!.name).toBe('general');
});

test('shared moderation carriers remove cached messages only with current authority', async () => {
  const f = fixture;
  const { community, folded } = bootstrapFixture(f);
  expect(folded.incomplete).toEqual([]);
  const channel = channelsView(community, folded).find(c => c.idHex === f.expected.message.channelId)!;
  const opened = await openChatBatch([f.chatEvent, f.bannedChatEvent, f.moderatorDeleteEvent, f.unprivilegedDeleteEvent, f.uncitedModeratorDeleteEvent, f.citedUnprivilegedDeleteEvent], channel);
  expect(opened).toHaveLength(6);
  const [message, banned, moderatorDelete, unprivilegedDelete, uncitedModeratorDelete, citedUnprivilegedDelete] = opened;
  expect(unprivilegedDelete.author).toBe(f.expected.bystander);
  expect(uncitedModeratorDelete.author).toBe(f.expected.moderator);
  const moderation = { banned: folded.banned, canDelete: (actor: string, author: string, action: any) =>
    citationSatisfied(folded, community.id, actor, action?.citation) && canActOnMember(folded.roster, actor, community.owner, author, Permissions.MANAGE_MESSAGES) };
  const ids = (events: typeof opened, m = moderation) => foldTimeline(events, m).messages.map(e => e.rumorId);
  expect(ids([message, banned])).toEqual([f.expected.message.id]);
  // A signed deletion by a member with no Grant leaves the message...
  expect(ids([message, banned, unprivilegedDelete])).toEqual([f.expected.message.id]);
  // ...and only the predicate keeps it: a client that lets anyone delete loses it.
  expect(ids([message, unprivilegedDelete], { ...moderation, canDelete: () => true })).toEqual([]);
  // The moderator's deletion without a citation parks; a predicate that checks
  // only the permission honours it, so this vector is what catches that.
  expect(ids([message, uncitedModeratorDelete])).toEqual([f.expected.message.id]);
  const permissionOnly = { ...moderation, canDelete: (actor: string, author: string) =>
    canActOnMember(folded.roster, actor, community.owner, author, Permissions.MANAGE_MESSAGES) };
  expect(ids([message, uncitedModeratorDelete], permissionOnly)).toEqual([]);
  // Staff whose role lacks MANAGE_MESSAGES, with a citation that holds: only
  // the permission keeps the message, so a citation-only predicate loses it.
  expect(citedUnprivilegedDelete.author).toBe(f.expected.channelManager);
  expect(citationSatisfied(folded, community.id, citedUnprivilegedDelete.author, citationFromTags(citedUnprivilegedDelete.tags))).toBe(true);
  expect(ids([message, citedUnprivilegedDelete])).toEqual([f.expected.message.id]);
  const citationOnly = { ...moderation, canDelete: (actor: string, _author: string, action: any) =>
    citationSatisfied(folded, community.id, actor, action?.citation) };
  expect(ids([message, citedUnprivilegedDelete], citationOnly)).toEqual([]);
  // The moderator's cited deletion of the owner's message: citation and
  // permission hold, so only the rank check keeps it. A predicate that checks
  // the permission with isAuthorized instead of canActOnMember loses it.
  const [ownerMessage, moderatorDeletesOwner] = await openChatBatch([f.ownerChatEvent, f.moderatorDeletesOwnerEvent], channel);
  expect(ownerMessage.author).toBe(community.owner);
  expect(citationSatisfied(folded, community.id, moderatorDeletesOwner.author, citationFromTags(moderatorDeletesOwner.tags))).toBe(true);
  expect(ids([ownerMessage, moderatorDeletesOwner])).toEqual([f.expected.ownerMessageId]);
  const noRank = { ...moderation, canDelete: (actor: string, _author: string, action: any) =>
    citationSatisfied(folded, community.id, actor, action?.citation) && isAuthorized(folded.roster, actor, community.owner, Permissions.MANAGE_MESSAGES) };
  expect(ids([ownerMessage, moderatorDeletesOwner], noRank)).toEqual([]);
  // With its citation, the same moderator's deletion removes the message.
  expect(ids([message, banned, moderatorDelete])).toEqual([]);
});
