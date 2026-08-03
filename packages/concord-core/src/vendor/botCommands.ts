/**
 * Bot command manifest constants, extracted from armada `src/lib/botCommands.ts`.
 *
 * They live here rather than in `kinds.ts` because armada keeps them outside
 * `concord-v2/lib` — the draft bot NIP is transport-agnostic, not a Concord
 * plane kind — and `kinds.ts` is overwritten wholesale by the sync script.
 *
 * Only the wire constants are vendored; armada's validator/parser is zod-based
 * and the bridge only ever WRITES a manifest (see `ConcordClient.publishManifest`).
 */

/** Replaceable manifest: one authoritative command catalog per bot pubkey. */
export const KIND_BOT_MANIFEST = 10304;

/** Routing tag naming the bot that should act. Routing, NOT authorization. */
export const BOT_TAG = "bot";
