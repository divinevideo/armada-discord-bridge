/**
 * Timeline scheduling. Each seed's authored `at` values (minutes, relative) are
 * min-max scaled into ONE fixed publish window so every community reads as ~8
 * days of activity ending "now", and preview == live. Relative spacing between
 * messages is preserved; only the absolute range is normalized.
 */

import type { CommunitySeed, SeedMessage } from "./types";

/** The window every community's history is mapped onto. */
export const WINDOW_START = Date.parse("2026-07-24T00:00:00Z");
export const WINDOW_END = Date.parse("2026-08-01T09:00:00Z");

export interface Scheduled {
  m: SeedMessage;
  index: number;
  ms: number;
}

/** Messages with absolute ms in the window, sorted oldest-first. */
export function schedule(seed: CommunitySeed): Scheduled[] {
  const ats = seed.messages.map((m) => m.at);
  const min = Math.min(...ats);
  const max = Math.max(...ats);
  const span = max > min ? max - min : 1;
  return seed.messages
    .map((m, index) => ({
      m,
      index,
      ms: Math.round(WINDOW_START + ((m.at - min) / span) * (WINDOW_END - WINDOW_START)),
    }))
    .sort((a, b) => a.ms - b.ms);
}
