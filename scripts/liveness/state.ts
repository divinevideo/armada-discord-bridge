/**
 * Daemon state, one JSON file (LIVENESS_STATE, default alongside this script):
 * reddit posts already shared, recent generated texts per community (repetition
 * guard fed back into prompts), and last-post time per community/channel
 * (staleness weighting). Load-modify-save per tick; the daemon is the only
 * writer.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface LivenessState {
  seenReddit: string[];
  /** community key → last ~20 generated message texts. */
  recent: Record<string, string[]>;
  /** `${community}|${channel}` → epoch ms of our last post there. */
  lastPost: Record<string, number>;
  /** `${community}` → persona id of the most recent author (anti-monologue). */
  lastAuthor: Record<string, string>;
}

const EMPTY: LivenessState = { seenReddit: [], recent: {}, lastPost: {}, lastAuthor: {} };

export function statePath(): string {
  return process.env.LIVENESS_STATE?.trim() || join(import.meta.dir, "state.json");
}

export function loadState(): LivenessState {
  const p = statePath();
  if (!existsSync(p)) return structuredClone(EMPTY);
  try {
    return { ...structuredClone(EMPTY), ...JSON.parse(readFileSync(p, "utf8")) };
  } catch {
    return structuredClone(EMPTY);
  }
}

export function saveState(state: LivenessState): void {
  state.seenReddit = state.seenReddit.slice(-2000);
  for (const k of Object.keys(state.recent)) state.recent[k] = state.recent[k]!.slice(-20);
  const p = statePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(state, null, 2)}\n`);
}
