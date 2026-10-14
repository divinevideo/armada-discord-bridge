/** Keep authorization adjacent to each external effect, including retries and media work. */
export function guardEffects<T extends object>(
  port: T,
  before: () => Promise<void>,
  methods: ReadonlySet<string>,
): T {
  return new Proxy(port, {
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
}
