import { expect, test } from 'bun:test';
import { baseRekeyGroupKey, bundleToEntry, checkContinuity, controlGroups, foldControlState, groupRotations, isDissolved, openControlWraps, openWrap, parseBundleEvent, parseInviteLink, parseRekey, rehydrateCommunity, validateBundle } from '@armada-bridge/concord-core';
import fixture from '../../test-fixtures/concord/community-lifecycle.json';

test('shared lifecycle carriers authenticate owner rotation and dissolution', () => {
  const invite = parseInviteLink(fixture.inviteUrl)!;
  const bundle = validateBundle(parseBundleEvent(fixture.bundleEvent, invite.linkSigner, invite.token, Date.now()));
  const community = rehydrateCommunity(bundleToEntry(bundle))!;
  const folded = foldControlState(openControlWraps(fixture.controlEvents, controlGroups(community)), community.id, community.owner);
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
});
