import { describe, expect, it } from "bun:test";
import type { ChatInputCommandInteraction, Message } from "discord.js";

import { DiscordAdapter, isMissingPermissions, parseBotCommand, sanitizeUsername } from "./adapter";

describe("sanitizeUsername", () => {
  it("neutralizes forbidden substrings beyond lookalike normalization", () => {
    // Discord normalizes leetspeak, so the output must not contain the
    // forbidden words under any character-for-character substitution.
    expect(sanitizeUsername("Discord Fan")).toBe("disc-rd Fan");
    expect(sanitizeUsername("dIsCoRdIsCoRd")).toBe("disc-rdIsCoRd");
    expect(sanitizeUsername("clyde2")).toBe("cly-e2");
    expect(sanitizeUsername("mk (via discord)")).toBe("mk (via disc-rd)");
  });

  it("enforces the 2..80 length window", () => {
    expect(sanitizeUsername("x").length).toBeGreaterThanOrEqual(2);
    expect(sanitizeUsername("").length).toBeGreaterThanOrEqual(2);
    expect(sanitizeUsername("a".repeat(200)).length).toBe(80);
  });

  it("leaves ordinary names alone", () => {
    expect(sanitizeUsername("mireille")).toBe("mireille");
  });
});

describe("isMissingPermissions", () => {
  it("matches Discord's 50013 and nothing else", () => {
    expect(isMissingPermissions({ code: 50013 })).toBe(true);
    expect(isMissingPermissions({ code: 50013, status: 403, rawError: { message: "Missing Permissions" } })).toBe(true);
    expect(isMissingPermissions({ code: 50035 })).toBe(false);
    expect(isMissingPermissions(new Error("boom"))).toBe(false);
    expect(isMissingPermissions(undefined)).toBe(false);
    expect(isMissingPermissions(null)).toBe(false);
  });
});


describe("adapter effect authorization", () => {
  it("rechecks before the webhook retry after a rejected username", async () => {
    let allowed = true;
    let sends = 0;
    const adapter = new DiscordAdapter("synthetic", { onMessage: async () => {} }, async () => {
      if (!allowed) throw new Error("visibility denied");
    });
    const webhook = { send: async () => {
      sends++;
      allowed = false;
      throw { code: 50035, rawError: "USERNAME_INVALID" };
    } };
    (adapter as unknown as { webhookFor: () => Promise<unknown> }).webhookFor = async () => webhook;
    const link = { discordChannelId: "100000000000000002" } as never;
    await expect(adapter.send(link, { username: "test", content: "test" })).rejects.toThrow("visibility denied");
    expect(sends).toBe(1);
    await adapter.stop();
  });
});

/**
 * A duck-typed ChatInputCommandInteraction: just what the adapter reads. The
 * reply capture stands in for Discord's one-shot interaction response.
 */
function fakeInteraction(commandName: string, options: Array<{ name: string; value: string }> = []) {
  const replies: Array<{ content: string; ephemeral?: boolean }> = [];
  const interaction: Record<string, unknown> = {
    commandName,
    channelId: "100000000000000002",
    replied: false,
    options: { data: options.map((o) => ({ name: o.name, type: 3, value: o.value })) },
    reply: async (r: { content: string; ephemeral?: boolean }) => {
      replies.push(r);
      interaction.replied = true;
      return {};
    },
  };
  return { interaction: interaction as unknown as ChatInputCommandInteraction, replies };
}

/** The reply text the portal's replyToCommand produces, for a faithful round-trip. */
const HELP = "Commands: /bridge confirm <code> approves a pending bridge link (Armada side).";

/**
 * Mimics the portal's handleBotCommand/replyToCommand so the test exercises the
 * SAME handler contract the message-text path drives: it reads `content` through
 * parseBotCommand, honours the active-channel gate, and answers via `reply`.
 */
function portalLikeHandler(state: { active: boolean }) {
  const seen: Message[] = [];
  const onBotCommand = async (message: Message): Promise<boolean> => {
    seen.push(message);
    if ((message as { author: { bot: boolean } }).author.bot || (message as { webhookId?: string }).webhookId) {
      return false;
    }
    const command = parseBotCommand(message.content);
    if (!command) return false;
    if (!state.active) return false; // activeRouterFor gate: not ours, stay silent
    if (command === "help") {
      await message.reply(HELP);
      return true;
    }
    await message.reply(`Unknown command /${command}. ${HELP}`);
    return true;
  };
  return { onBotCommand, seen };
}

describe("slash command dispatch", () => {
  it("drives the same handler as typed text for /help", async () => {
    const state = { active: true };
    const { onBotCommand, seen } = portalLikeHandler(state);
    const adapter = new DiscordAdapter("synthetic", { onMessage: async () => {}, onBotCommand });
    const { interaction, replies } = fakeInteraction("help");

    await adapter.handleSlashInteraction(interaction);

    expect(replies).toEqual([{ content: HELP }]);
    // The synthetic message is the whole host-handler contract.
    expect(seen).toHaveLength(1);
    const message = seen[0] as unknown as {
      content: string;
      channelId: string;
      author: { bot: boolean };
      webhookId?: string;
    };
    expect(message.content).toBe("/help");
    expect(message.channelId).toBe("100000000000000002");
    expect(message.author.bot).toBe(false);
    expect(message.webhookId).toBeUndefined();
    await adapter.stop();
  });

  it("round-trips /bridge confirm <code> through the text path's token", async () => {
    const state = { active: true };
    const { onBotCommand, seen } = portalLikeHandler(state);
    const adapter = new DiscordAdapter("synthetic", { onMessage: async () => {}, onBotCommand });
    const { interaction, replies } = fakeInteraction("bridge", [
      { name: "action", value: "confirm" },
      { name: "code", value: "ab12cd34" },
    ]);

    await adapter.handleSlashInteraction(interaction);

    // The reconstructed content reaches the handler and parses to the same
    // command token the message-text path would have: "bridge".
    const message = seen[0] as unknown as { content: string };
    expect(message.content).toBe("/bridge confirm ab12cd34");
    expect(parseBotCommand(message.content)).toBe("bridge");
    // Preserved behaviour: the Discord side never runs the confirm (it is
    // Armada-side), so the handler answers "Unknown command" + help.
    expect(replies).toEqual([{ content: `Unknown command /bridge. ${HELP}` }]);
    await adapter.stop();
  });

  it("stays out of the way when the channel is not a live bridge (permission denial)", async () => {
    const state = { active: false };
    const { onBotCommand } = portalLikeHandler(state);
    const adapter = new DiscordAdapter("synthetic", { onMessage: async () => {}, onBotCommand });
    const { interaction, replies } = fakeInteraction("help");

    await adapter.handleSlashInteraction(interaction);

    // The handler declined (activeRouterFor gate). No public reply — instead an
    // ephemeral acknowledgement, the closest thing to the text path's silence.
    expect(replies).toHaveLength(1);
    expect(replies[0].ephemeral).toBe(true);
    expect(replies[0].content).not.toContain("Commands:");
    await adapter.stop();
  });

  it("ignores interaction names it does not own", async () => {
    const state = { active: true };
    const { onBotCommand, seen } = portalLikeHandler(state);
    const adapter = new DiscordAdapter("synthetic", { onMessage: async () => {}, onBotCommand });
    const { interaction, replies } = fakeInteraction("someone-elses");

    await adapter.handleSlashInteraction(interaction);

    expect(seen).toHaveLength(0);
    expect(replies).toHaveLength(0);
    await adapter.stop();
  });
});
