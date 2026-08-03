import { describe, expect, it } from "bun:test";

import {
  channelPosition,
  compareChannelOrder,
  reorderPositions,
  withChannelPosition,
} from "./channelOrder";

import type { ChannelMetadata } from "./types";

describe("channel order metadata", () => {
  it("round-trips a position without disturbing other extensions", () => {
    const base: ChannelMetadata = { name: "c", private: false, custom: { "armada.git": { repositories: [] } } };
    const placed = withChannelPosition(base, 3);
    expect(channelPosition(placed)).toBe(3);
    expect((placed.custom as Record<string, unknown>)["armada.git"]).toEqual({ repositories: [] });

    const cleared = withChannelPosition(placed, undefined);
    expect(channelPosition(cleared)).toBeUndefined();
    expect((cleared.custom as Record<string, unknown>)["armada.git"]).toEqual({ repositories: [] });
  });

  it("reads a malformed position as unpositioned rather than throwing", () => {
    expect(channelPosition({ name: "c", private: false })).toBeUndefined();
    for (const position of [-1, 1.5, "2", null]) {
      expect(channelPosition({ name: "c", private: false, custom: { "armada.order": { position } } })).toBeUndefined();
    }
  });
});

describe("display order", () => {
  it("positioned channels lead, unpositioned follow alphabetically", () => {
    const channels = [
      { name: "zebra", position: 0 },
      { name: "alpha" },
      { name: "middle", position: 1 },
      { name: "beta" },
    ];
    expect([...channels].sort(compareChannelOrder).map((c) => c.name)).toEqual([
      "zebra",
      "middle",
      "alpha",
      "beta",
    ]);
  });
});

describe("reorderPositions", () => {
  const ordered = [
    { idHex: "a", position: 0 },
    { idHex: "b", position: 1 },
    { idHex: "c", position: 2 },
  ];

  it("an ordinary neighbour swap republishes exactly the two channels that moved", () => {
    expect(reorderPositions(ordered, 2, 1)).toEqual([
      { idHex: "c", position: 1 },
      { idHex: "b", position: 2 },
    ]);
  });

  it("the first reorder in an unordered community stamps every channel", () => {
    const unordered = [{ idHex: "a" }, { idHex: "b" }, { idHex: "c" }];
    expect(reorderPositions(unordered, 2, 0)).toEqual([
      { idHex: "c", position: 0 },
      { idHex: "a", position: 1 },
      { idHex: "b", position: 2 },
    ]);
  });

  it("a no-op or out-of-range move publishes nothing", () => {
    expect(reorderPositions(ordered, 1, 1)).toEqual([]);
    expect(reorderPositions(ordered, 0, -1)).toEqual([]);
    expect(reorderPositions(ordered, 2, 3)).toEqual([]);
  });
});
