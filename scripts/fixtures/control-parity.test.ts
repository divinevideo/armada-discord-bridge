import { expect, test } from 'bun:test';
import { bytesToHex, foldControlState, hex32, parseEdition } from '@armada-bridge/concord-core';
import type { OpenedEvent } from '@armada-bridge/concord-core';
import fixture from '../../test-fixtures/concord/control-parity.json';
type Projection = { heads: Record<string, { version: string; hash: string }>; incomplete: string[]; banned: string[] };
for (const c of fixture.cases) test(`native differential control vector: ${c.name}`, () => {
  const prior = new Map(Object.entries(c.priorHeads).map(([id, head]) => [id, { version: BigInt(head.version), hash: hex32(head.hash) }]));
  const folded = foldControlState(c.opened.map(e => parseEdition(e as unknown as OpenedEvent)), hex32(fixture.communityId), fixture.owner, prior.size ? prior : undefined, c.snapshotRumorIds.length ? new Set(c.snapshotRumorIds) : undefined);
  const heads = Object.fromEntries([...folded.heads].map(([id,h])=>[id,{version:h.version.toString(),hash:bytesToHex(h.hash)}]));
  expect({heads,incomplete:[...folded.incomplete].sort(),banned:[...folded.banned].sort()}).toEqual(c.expected as unknown as Projection);
});
