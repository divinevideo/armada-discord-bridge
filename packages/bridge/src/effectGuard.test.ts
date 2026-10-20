import { expect, it } from "bun:test";
import { guardEffects } from "./effectGuard";

it("coalesces only identical guards on the same immediate method boundary", async () => {
  let checks = 0;
  const effects: string[] = [];
  const before = async () => { checks++; };
  const inner = guardEffects({ async send() { effects.push("send"); }, async other() { effects.push("other"); } }, before, new Set(["send"]));
  const outer = guardEffects(inner, before, new Set(["send", "other"]));
  await outer.send();
  await outer.other();
  expect(checks).toBe(2);
  expect(effects).toEqual(["send", "other"]);
  await inner.send();
  expect(checks).toBe(3);
});

it("retains different guards and reauthorizes on the next invocation", async () => {
  let allowed = true;
  let effects = 0;
  const calls: string[] = [];
  const inner = guardEffects({ async send() { effects++; } }, async () => {
    calls.push("inner");
    if (!allowed) throw new Error("revoked");
  }, new Set(["send"]));
  const outer = guardEffects(inner, async () => { calls.push("outer"); }, new Set(["send"]));
  await outer.send();
  allowed = false;
  await expect(outer.send()).rejects.toThrow("revoked");
  expect(calls).toEqual(["outer", "inner", "outer", "inner"]);
  expect(effects).toBe(1);
});
