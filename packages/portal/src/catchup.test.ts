import { describe, expect, it } from "bun:test";

import { replayDiscordSince } from "./catchup";
import type { DiscordCatchUpIo } from "./catchup";
import type { RestMessage } from "./discordRest";

const T0 = Date.parse("2026-09-23T19:00:00Z");

function msg(id: number, overrides: Partial<RestMessage> = {}): RestMessage {
  return {
    id: String(id),
    type: 0,
    content: `message ${id}`,
    timestamp: new Date(T0 + id * 1000).toISOString(),
    author: { id: "42", username: "someone" },
    ...overrides,
  };
}

/** A channel whose history is `messages`, served like Discord: 100 per page, newest first. */
function channel(messages: RestMessage[], mirroredIds: string[] = []) {
  const published: string[] = [];
  const fetches: string[] = [];
  const io: DiscordCatchUpIo = {
    fetchAfter: async (afterId) => {
      fetches.push(afterId);
      return messages
        .filter((m) => BigInt(m.id) > BigInt(afterId))
        .sort((a, b) => Number(BigInt(a.id) - BigInt(b.id)))
        .slice(0, 100)
        .reverse();
    },
    alreadyMirrored: async (id) => mirroredIds.includes(id) || published.includes(id),
    mirror: async (message) => {
      published.push(message.id);
      return true;
    },
  };
  return { io, published, fetches };
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => msg(from + i));

describe("replayDiscordSince", () => {
  it("replays everything after the anchor, oldest first, across pages", async () => {
    const { io, published, fetches } = channel(range(1, 250));
    const result = await replayDiscordSince("10", T0 + 10_000_000, 500, io);
    expect(published).toEqual(range(11, 250).map((m) => m.id));
    expect(result).toEqual({ mirrored: 240, capped: false });
    // Each page picks up after the newest id of the one before.
    expect(fetches).toEqual(["10", "110", "210"]);
  });

  it("stops at the live cutoff, leaving later messages to the gateway", async () => {
    const { io, published } = channel(range(1, 50));
    // Message 30 was posted at T0+30s: the moment routing attached.
    await replayDiscordSince("0", T0 + 30_000, 500, io);
    expect(published).toEqual(range(1, 29).map((m) => m.id));
  });

  it("skips what is already mirrored, system messages, and bot commands", async () => {
    const { io, published } = channel(
      [msg(1), msg(2, { type: 7 }), msg(3, { content: "/help" }), msg(4), msg(5, { type: 19 })],
      ["4"],
    );
    const result = await replayDiscordSince("0", T0 + 10_000_000, 500, io);
    expect(published).toEqual(["1", "5"]);
    expect(result.mirrored).toBe(2);
  });

  it("reads at most `max` messages and says so", async () => {
    const { io, published } = channel(range(1, 300));
    const result = await replayDiscordSince("0", T0 + 10_000_000, 120, io);
    expect(published).toEqual(range(1, 120).map((m) => m.id));
    expect(result.capped).toBe(true);
  });

  it("counts only messages the router actually published", async () => {
    const { io } = channel(range(1, 3));
    const result = await replayDiscordSince("0", T0 + 10_000_000, 500, {
      ...io,
      mirror: async (message) => message.id !== "2", // e.g. empty after conversion
    });
    expect(result.mirrored).toBe(2);
  });

  it("does nothing for a channel it cannot read", async () => {
    const result = await replayDiscordSince("0", T0, 500, {
      fetchAfter: async () => undefined,
      alreadyMirrored: async () => false,
      mirror: async () => {
        throw new Error("must not be called");
      },
    });
    expect(result).toEqual({ mirrored: 0, capped: false });
  });
});
