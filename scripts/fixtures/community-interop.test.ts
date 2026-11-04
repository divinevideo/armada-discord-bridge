import { expect, test } from 'bun:test';
import { bytesToHex, canActOnMember, channelsView, citationSatisfied, controlGroups, foldTimeline, isAuthorized, openChatBatch, openControlWraps, Permissions } from '@armada-bridge/concord-core';
import fixture from '../../test-fixtures/concord/community-interop.json';
import moderationFixture from '../../test-fixtures/concord/community-moderation.json';
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
  // plaintext seal and a carrier bound to another channel or epoch, which is
  // what makes the message admissible for the channel it claims.
  const opened = await openChatBatch([fixture.chatEvent], channel);
  expect(opened).toHaveLength(1);
  expect(opened[0].channelIdHex).toBe(fixture.expected.message.channelId);
  expect(opened[0].rumorId).toBe(fixture.expected.message.id);
  expect(opened[0].content).toBe(fixture.expected.message.content);
  expect(opened[0].author).toBe(fixture.expected.member);
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
  const f = moderationFixture;
  const { community, folded } = bootstrapFixture(f);
  expect(folded.incomplete).toEqual([]);
  const channel = channelsView(community, folded).find(c => c.idHex === f.expected.message.channelId)!;
  const opened = await openChatBatch([f.chatEvent, f.bannedChatEvent, f.moderatorDeleteEvent], channel);
  expect(opened).toHaveLength(3);
  const moderation = { banned: folded.banned, canDelete: (actor: string, author: string, action: any) =>
    citationSatisfied(folded, community.id, actor, action?.citation) && canActOnMember(folded.roster, actor, community.owner, author, Permissions.MANAGE_MESSAGES) };
  expect(foldTimeline(opened.slice(0, 2), moderation).messages.map(m => m.rumorId)).toEqual([f.expected.message.id]);
  expect(foldTimeline(opened, moderation).messages).toEqual([]);
  expect(foldTimeline(opened, { ...moderation, canDelete: () => false }).messages).toHaveLength(1);
});
