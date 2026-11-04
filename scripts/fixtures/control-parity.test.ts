import { expect, test } from 'bun:test';
import { bytesToHex, foldControlState, hex32, parseEdition } from '@armada-bridge/concord-core';
import type { OpenedEvent } from '@armada-bridge/concord-core';
import fixture from '../../test-fixtures/concord/control-parity.json';
type Projection = { heads: Record<string, { version: string; hash: string }>; incomplete: string[]; banned: string[] };
type Case = (typeof fixture.cases)[number];
const fold = (c: Case, inputs = { prior: true, snapshots: true }): Projection => {
  const prior = new Map(Object.entries(c.priorHeads).map(([id, head]) => [id, { version: BigInt(head.version), hash: hex32(head.hash) }]));
  const folded = foldControlState(c.opened.map(e => parseEdition(e as unknown as OpenedEvent)), hex32(fixture.communityId), fixture.owner, inputs.prior && prior.size ? prior : undefined, inputs.snapshots && c.snapshotRumorIds.length ? new Set(c.snapshotRumorIds) : undefined);
  const heads = Object.fromEntries([...folded.heads].map(([id,h])=>[id,{version:h.version.toString(),hash:bytesToHex(h.hash)}]));
  return {heads,incomplete:[...folded.incomplete].sort(),banned:[...folded.banned].sort()};
};
for (const c of fixture.cases) test(`native differential control vector: ${c.name}`, () => {
  expect(fold(c)).toEqual(c.expected as unknown as Projection);
});
test('every prior head is one of the served editions', () => {
  // divine-mobile's parity harness builds its floors by finding each prior head
  // among `opened`; a floor naming an edition the case does not serve crashes it.
  for (const c of fixture.cases) {
    const served = new Set(c.opened.map(e => bytesToHex(parseEdition(e as unknown as OpenedEvent).selfHash)));
    for (const head of Object.values(c.priorHeads)) expect(served.has(head.hash)).toBe(true);
  }
});
test('each attribution input decides at least one native vector', () => {
  // A native fold that ignored priorHeads or snapshotRumorIds outright must
  // fail some case, or the fixture cannot tell it from a correct one.
  const decides = (inputs: { prior: boolean; snapshots: boolean }) =>
    fixture.cases.some(c => !Bun.deepEquals(fold(c, inputs), c.expected));
  expect(decides({ prior: false, snapshots: true })).toBe(true);
  expect(decides({ prior: true, snapshots: false })).toBe(true);
});
