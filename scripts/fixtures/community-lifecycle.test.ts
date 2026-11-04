import { expect, test } from 'bun:test';
import { dissolvedGroupKey, bytesToHex, channelsView, baseRekeyGroupKey, checkContinuity, groupRotations, isDissolved, openWrap, parseRekey } from '@armada-bridge/concord-core';
import fixture from '../../test-fixtures/concord/community-lifecycle.json';
import { bootstrapFixture } from './community-bootstrap';

test('shared lifecycle carriers authenticate owner rotation and dissolution', () => {
  const { community, folded } = bootstrapFixture(fixture);
  expect(folded.incomplete).toEqual([]);
  const group = baseRekeyGroupKey(community.root, community.id, BigInt(fixture.nextEpoch));
  const rotations = groupRotations(fixture.baseRekeyEvents.map(event => parseRekey(openWrap(event, group))));
  expect(rotations).toHaveLength(1);
  const rotation = rotations[0];
  expect(rotation.complete).toBe(true);
  expect(rotation.rotator).toBe(community.owner);
  expect(rotation.newEpoch).toBe(community.rootEpoch + 1n);
  expect(rotation.scopeIdHex).toBe('0'.repeat(64));
  expect(checkContinuity(rotation, community.rootEpoch, community.root)).toEqual({ ok: true });
  expect(isDissolved(fixture.dissolvedEvents, community.id, community.owner)).toBe(true);
  expect(isDissolved(fixture.impostorDissolvedEvents, community.id, community.owner)).toBe(false);
  // Each of these isolates one check, so a client missing it accepts that one.
  const dissolvedAt = dissolvedGroupKey(community.id);
  expect(() => openWrap(fixture.forgedAuthorDissolvedEvents[0], dissolvedAt)).toThrow('rumor author does not match');
  expect(isDissolved(fixture.forgedAuthorDissolvedEvents, community.id, community.owner)).toBe(false);
  const replayed = openWrap(fixture.replayedDissolvedEvents[0], dissolvedAt);
  expect(replayed.author).toBe(community.owner);
  expect(replayed.tags.find(t => t[0] === 'eid')![1]).not.toBe(community.idHex);
  expect(isDissolved(fixture.replayedDissolvedEvents, community.id, community.owner)).toBe(false);
  expect(fixture.refreshedBundleEvent.created_at).toBeGreaterThan(fixture.bundleEvent.created_at);
  const { community: refreshed, folded: restored } = bootstrapFixture({
    inviteUrl: fixture.inviteUrl, bundleEvent: fixture.refreshedBundleEvent, controlEvents: fixture.nextEpochControlEvents,
  }, folded.heads);
  expect(refreshed.idHex).toBe(community.idHex);
  expect(refreshed.rootEpoch).toBe(rotation.newEpoch);
  expect(bytesToHex(refreshed.root)).not.toBe(bytesToHex(community.root));
  expect(refreshed.controlRoot).toBeUndefined();
  expect(restored.incomplete).toEqual([]);
  expect(restored.heads).toEqual(folded.heads);
  expect(channelsView(refreshed, restored).map(c => c.idHex)).toEqual(channelsView(community, folded).map(c => c.idHex));
});
