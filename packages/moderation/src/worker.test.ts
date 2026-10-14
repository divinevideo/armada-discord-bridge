import { expect, test } from "bun:test";
import { executeDelivery } from "./worker";
import { moderationFixture } from "../../../scripts/fixtures/moderation-events";
test("relay delivery can succeed independently of a Discord rate limit", async () => {
  const f = await moderationFixture();
  const calls: string[] = [];
  const context: any = {
    authorize: async () => { calls.push("authorize"); }, assertCurrent: async () => {},
    removeFromRelay: async () => ({ state: "verified" }),
    discord: { execute: async () => ({ state: "failed", code: "discord_rate_limited" }) },
  };
  expect(await executeDelivery(f.decision, "divine_relay", context)).toEqual({ state: "verified", code: "relay_removal_verified" });
  expect(await executeDelivery(f.decision, "discord", context)).toEqual({ state: "failed", code: "discord_rate_limited" });
  expect(calls).toEqual(["authorize", "authorize"]);
});
test("revocation prevents every external effect", async () => {
  const f = await moderationFixture();
  for (const target of ["divine_relay", "concord", "discord"] as const) {
    expect((await executeDelivery(f.decision, target, { authorize: async () => { throw new Error("revoked"); } } as any)).state).toBe("failed");
  }
});
