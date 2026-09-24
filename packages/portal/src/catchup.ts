/**
 * Discord-side catch-up: replay what a Discord channel said while the portal
 * was not listening. The loop lives here, apart from BridgeManager, so its
 * edges — ordering, the live cutoff, the cap — are testable without a
 * gateway, a database or a relay.
 */

import { parseBotCommand } from "@armada-bridge/bridge/src/discord/adapter";

import type { RestMessage } from "./discordRest";

export interface DiscordCatchUpIo {
  /** One page strictly after `afterId`, newest first; undefined if unreadable. */
  fetchAfter(afterId: string): Promise<RestMessage[] | undefined>;
  /** Whether this message already has a mapping row (mirrored before). */
  alreadyMirrored(messageId: string): Promise<boolean>;
  /** Mirror one message; resolves true when it was published. */
  mirror(message: RestMessage): Promise<boolean>;
}

export interface DiscordCatchUpResult {
  mirrored: number;
  /** True when the cap cut the replay short of the live cutoff. */
  capped: boolean;
}

const PAGE_SIZE = 100;

/**
 * Replay messages after `anchorId`, oldest first, up to (not including) the
 * first one posted at or after `liveFromMs` — from then on the gateway
 * delivers, and replaying past it would race the live path into publishing
 * the same message twice. At most `max` messages are read.
 *
 * System messages are skipped, and so are bot commands: the live gateway
 * hands those to the command handler rather than the router, and one that
 * arrived while nobody was listening gets no late reply.
 */
export async function replayDiscordSince(
  anchorId: string,
  liveFromMs: number,
  max: number,
  io: DiscordCatchUpIo,
): Promise<DiscordCatchUpResult> {
  let after = anchorId;
  let mirrored = 0;
  let seen = 0;
  for (;;) {
    const page = await io.fetchAfter(after);
    if (!page || page.length === 0) return { mirrored, capped: false };
    // Pages arrive newest first; replay oldest first so reply targets exist
    // by the time a message cites them.
    const oldestFirst = [...page].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    for (const message of oldestFirst) {
      if (Date.parse(message.timestamp) >= liveFromMs) return { mirrored, capped: false };
      if (seen >= max) return { mirrored, capped: true };
      seen++;
      after = message.id;
      if (message.type !== 0 && message.type !== 19) continue;
      if (parseBotCommand(message.content ?? "")) continue;
      if (await io.alreadyMirrored(message.id)) continue;
      if (await io.mirror(message)) mirrored++;
    }
    if (page.length < PAGE_SIZE) return { mirrored, capped: false };
  }
}
