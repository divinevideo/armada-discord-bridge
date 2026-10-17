const guards = new WeakMap<object, { port: object; before: () => Promise<void>; methods: ReadonlySet<string> }>();

export const CONCORD_EFFECT_METHODS: ReadonlySet<string> = new Set([
  "sendChat", "sendTyping", "publishJoin", "publishProfile", "publishDmRelays", "publishManifest", "backfillChannel",
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
        return Reflect.apply(value, target, args);
      };
    },
  });
  guards.set(guarded, { port, before, methods });
  return guarded;
}
