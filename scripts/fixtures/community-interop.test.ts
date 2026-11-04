import { expect, test } from 'bun:test';
import { canActOnMember, citationSatisfied, foldTimeline, openChatBatch, Permissions, bundleToEntry, channelsView, controlGroups, foldControlState, openControlWraps, openWrap, parseBundleEvent, parseInviteLink, rehydrateCommunity, validateBundle } from '@armada-bridge/concord-core';
import fixture from '../../test-fixtures/concord/community-interop.json';
import moderationFixture from '../../test-fixtures/concord/community-moderation.json';

test('shared client fixture resolves real public channels and rejects the unauthorized rename', () => {
  const invite = parseInviteLink(fixture.inviteUrl)!;
  const bundle = validateBundle(parseBundleEvent(fixture.bundleEvent, invite.linkSigner, invite.token, Date.now()));
  const community = rehydrateCommunity(bundleToEntry(bundle))!;
  expect(community.idHex).toBe(fixture.expected.communityId);
  expect(community.controlRoot).toBeUndefined();
  const folded = foldControlState(openControlWraps(fixture.controlEvents, controlGroups(community)), community.id, community.owner);
  expect(folded.incomplete).toEqual([]);
  const rejected = foldControlState(openControlWraps([...fixture.controlEvents, ...fixture.rejectedControlEvents], controlGroups(community)), community.id, community.owner);
  expect(rejected.incomplete.length).toBeGreaterThan(0);
  expect(channelsView(community, rejected).map(c => c.name)).not.toContain("changed");
  const channels = channelsView(community, folded);
  expect(channels.map(c => ({ id: c.idHex, name: c.name, streams: c.streams.map(s => ({ pubkey: s.group.pk, epoch: Number(s.epoch) })) }))).toEqual(fixture.expected.channels);
  expect(channels.map(c => c.name).sort()).toEqual(['general', 'introductions']);
  expect(folded.banned.has(fixture.expected.bannedMember)).toBe(true);
  const channel = channels.find(c => c.idHex === fixture.expected.message.channelId)!;
  const opened = openWrap(fixture.chatEvent, channel.streams[0].group);
  expect(opened.rumorId).toBe(fixture.expected.message.id);
  expect(opened.content).toBe(fixture.expected.message.content);
  expect(opened.author).toBe(fixture.expected.member);
});

 test('shared moderation carriers remove cached messages only with current authority', async () => {
  const f = moderationFixture;
  const invite = parseInviteLink(f.inviteUrl)!;
  const bundle = validateBundle(parseBundleEvent(f.bundleEvent, invite.linkSigner, invite.token, Date.now()));
  const community = rehydrateCommunity(bundleToEntry(bundle))!;
  const folded = foldControlState(openControlWraps(f.controlEvents, controlGroups(community)), community.id, community.owner);
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
