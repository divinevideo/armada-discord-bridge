import { describe, expect, it } from "bun:test";

import { memoSet } from "./boundedMemo";

describe("memoSet", () => {
  it("evicts oldest-first once the cap is reached, reporting each eviction", () => {
    const memo = new Map<string, number>();
    const evicted: string[] = [];
    for (const [i, key] of ["a", "b", "c", "d"].entries()) memoSet(memo, key, i, 3, (k) => evicted.push(k));
    expect([...memo.keys()]).toEqual(["b", "c", "d"]);
    expect(evicted).toEqual(["a"]);
  });

  it("overwrites a present key without evicting anything", () => {
    const memo = new Map([["a", 1], ["b", 2]]);
    memoSet(memo, "a", 9, 2, () => {
      throw new Error("must not evict");
    });
    expect(memo.get("a")).toBe(9);
    expect(memo.size).toBe(2);
  });
});
