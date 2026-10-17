import { expect, test } from "bun:test";
import { DiscordActions } from "./discordActions";
const decision = { decisionId: crypto.randomUUID(), orgId: "synthetic", caseId: crypto.randomUUID(), target: { communityId: "a".repeat(64), channelId: "b".repeat(64), rumorId: "c".repeat(64) }, author: "d".repeat(64), action: "remove_message" as const, discordGuildConfirmed: false, expiresAt: new Date(Date.now() + 60_000) };
test("deletes every verified mapped part, tolerates missing copies and verifies absence", async () => {
  const calls: string[] = [];
  const mapped = ["100000000000000001", "100000000000000002"].map((messageId) => ({ guildId: "100000000000000000", channelId: "100000000000000003", messageId }));
  const actions = new DiscordActions({ async messages() { return mapped; }, async member() { return undefined; } }, { async assertPublicChannel() { calls.push("visibility"); } }, async (method, path) => { calls.push(method); return method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ code: 10008 }, { status: 404 }); });
  expect((await actions.execute(decision)).state).toBe("verified");
  expect(calls).toEqual(["visibility", "DELETE", "GET", "visibility", "DELETE", "GET"]);
});
test("native authors are not guessed and guild bans require explicit scope confirmation", async () => {
  let calls = 0;
  const actions = new DiscordActions({ async messages() { return []; }, async member() { return undefined; } }, { async assertPublicChannel() {} }, async () => { calls++; return new Response(null, { status: 204 }); });
  expect((await actions.execute({ ...decision, action: "ban_member", discordGuildConfirmed: true })).state).toBe("not_applicable");
  expect(calls).toBe(0);
});
test("rate limits retry after the provider delay and permission changes prevent the next effect", async () => {
  const mapping = { guildId: "100000000000000000", channelId: "100000000000000003", messageId: "100000000000000001" };
  const actions = new DiscordActions({ async messages() { return [mapping]; }, async member() { return undefined; } }, { async assertPublicChannel() {} }, async () => Response.json({ retry_after: 12 }, { status: 429 }));
  expect(await actions.execute(decision)).toEqual({ state: "pending", code: "discord_rate_limited", retryAfterSeconds: 12 });
  const closed = new DiscordActions({ async messages() { return [mapping]; }, async member() { return undefined; } }, { async assertPublicChannel() { throw new Error("private now"); } }, async () => { throw new Error("must not call"); });
  expect((await closed.execute(decision)).state).toBe("failed");
});
test("a missing channel is not evidence that a message was deleted", async () => {
  const actions = new DiscordActions({ async messages() { return [{ guildId: "100000000000000000", channelId: "100000000000000003", messageId: "100000000000000001" }]; }, async member() { return undefined; } }, { async assertPublicChannel() {} }, async () => Response.json({ code: 10003 }, { status: 404 }));
  expect((await actions.execute(decision)).state).toBe("failed");
});

test("transport exceptions retry but permission denial is terminal", async () => {
  const mappings = { async messages() { return [{ guildId: "100000000000000000", channelId: "100000000000000003", messageId: "100000000000000001" }]; }, async member() { return undefined; } };
  const policy = { async assertPublicChannel() {} };
  expect((await new DiscordActions(mappings, policy, async () => { throw new TypeError("network down"); }).execute(decision)).state).toBe("pending");
  expect((await new DiscordActions(mappings, policy, async () => new Response(null, { status: 403 })).execute(decision)).state).toBe("failed");
});
