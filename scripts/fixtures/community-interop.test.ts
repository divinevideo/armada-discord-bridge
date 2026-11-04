import { expect, test } from 'bun:test';
import { bundleToEntry, channelsView, controlGroups, foldControlState, openControlWraps, openWrap, parseBundleEvent, parseInviteLink, rehydrateCommunity, validateBundle } from '@armada-bridge/concord-core';
import fixture from '../../test-fixtures/concord/community-interop.json';

test('shared client fixture resolves real public channels and rejects the unauthorized rename', () => {
  const invite = parseInviteLink(fixture.inviteUrl)!;
  const bundle = validateBundle(parseBundleEvent(fixture.bundleEvent, invite.linkSigner, invite.token, Date.now()));
  const community = rehydrateCommunity(bundleToEntry(bundle))!;
  expect(community.idHex).toBe(fixture.expected.communityId);
  expect(community.controlRoot).toBeUndefined();
  const folded = foldControlState(openControlWraps(fixture.controlEvents, controlGroups(community)), community.id, community.owner);
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
