import { expect, test } from "bun:test";
import { executeDelivery, type ExecutionContext } from "./worker";
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
  for (const gate of ["authorize", "assertCurrent"] as const) {
    for (const action of ["remove_message", "ban_member", "unban_member"] as const) {
      for (const target of ["divine_relay", "concord", "discord"] as const) {
        const effects: string[] = [];
        const context: ExecutionContext = {
          authorize: async () => {}, assertCurrent: async () => {},
          removeFromRelay: async () => { effects.push("removeFromRelay"); return { state: "verified" }; },
          setRelayBan: async () => { effects.push("setRelayBan"); return true; },
          executeConcord: async () => { effects.push("executeConcord"); return { state: "verified", code: "concord_verified" }; },
          discord: { execute: async () => { effects.push("discord"); return { state: "verified", code: "discord_verified" }; } },
        };
        context[gate] = async () => { throw new Error("revoked"); };
        expect(await executeDelivery({ ...f.decision, action }, target, context)).toEqual({ state: "failed", code: "current_authority_or_delivery_unavailable" });
        expect(effects).toEqual([]);
      }
    }
  }
});
