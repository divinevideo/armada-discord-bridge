import { AsyncLocalStorage } from 'node:async_hooks';

type EffectGuard = () => Promise<void>;
const origin = new AsyncLocalStorage<{ guards: readonly EffectGuard[]; finalChecks: readonly (() => void)[] }>();

/** Async preparation and transport retries must retain the caller's proof.
 * Looking up today's channel owner here would authorize yesterday's call. */
export function withEffectGuard<T>(before: EffectGuard, work: () => T, finalCheck?: () => void): T {
  const inherited = origin.getStore() ?? { guards: [], finalChecks: [] };
  return origin.run({ guards: inherited.guards.includes(before) ? inherited.guards : [before, ...inherited.guards],
    finalChecks: finalCheck ? [...inherited.finalChecks, finalCheck] : inherited.finalChecks }, work);
}

export async function assertEffectCurrent(): Promise<void> {
  const context = origin.getStore();
  for (const before of context?.guards ?? []) await before();
  for (const check of context?.finalChecks ?? []) check();
}

const guards = new WeakMap<object, { port: object; before: () => Promise<void>; methods: ReadonlySet<string> }>();

export const CONCORD_EFFECT_METHODS: ReadonlySet<string> = new Set([
  "sendChat", "sendTyping", "publishJoin", "publishProfile", "publishDmRelays", "publishManifest", "backfillChannel", "repairDelivery",
]);

/** Keep authorization adjacent to each external effect, including retries and media work. */
export function guardEffects<T extends object>(
  port: T,
  before: () => Promise<void>,
  methods: ReadonlySet<string>,
): T {
  const existing = guards.get(port);
  // Only our own directly nested wrappers with the identical callback share a
  // boundary. No entry checks, adapter checks or different guards are removed.
  if (existing?.before === before) {
    port = existing.port as T;
    methods = new Set([...existing.methods, ...methods]);
  }
  const guarded = new Proxy(port, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (!methods.has(String(property))) return value.bind(target);
      return async (...args: unknown[]) => {
        await before();
        return withEffectGuard(before, () => Reflect.apply(value, target, args));
      };
    },
  });
  guards.set(guarded, { port, before, methods });
  return guarded;
}

/** Capture at request admission; a shared queue's ambient context is no proof. */
export function captureEffectGuard(): EffectGuard {
  const captured = origin.getStore() ?? { guards: [], finalChecks: [] };
  return () => origin.run(captured, assertEffectCurrent);
}
