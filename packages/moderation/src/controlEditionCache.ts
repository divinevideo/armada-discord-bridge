import { createHash } from "node:crypto";
import type { ParsedEdition } from "@armada-bridge/concord-core";
import type { NostrEvent } from "nostr-tools/pure";
import type { StreamDescriptor } from "./contracts";

/** Memoize cryptographic decoding only, never authority, freshness or a fold. */
export class ControlEditionCache {
  private readonly entries = new Map<string, { edition: ParsedEdition; bytes: number }>();
  private bytes = 0;
  constructor(private readonly maxEntries = 4096, private readonly maxWireBytes = 16 * 1024 * 1024) {}

  read(event: NostrEvent, stream: StreamDescriptor, decode: () => ParsedEdition): ParsedEdition {
    const wire = JSON.stringify(event), descriptor = JSON.stringify(stream);
    // IDs alone are not sufficient: altered bytes can retain a claimed ID or
    // signature, and read material can change while the stream pubkey stays put.
    const key = createHash("sha256").update(wire).update("\0").update(descriptor).digest("hex");
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key); this.entries.set(key, cached);
      return structuredClone(cached.edition);
    }
    const edition = decode(); // Failed verification must never populate a cache.
    const bytes = Buffer.byteLength(wire) + Buffer.byteLength(descriptor);
    if (this.maxEntries > 0 && bytes <= this.maxWireBytes) {
      while (this.entries.size && (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxWireBytes)) {
        const oldest = this.entries.keys().next().value!;
        this.bytes -= this.entries.get(oldest)!.bytes; this.entries.delete(oldest);
      }
      this.entries.set(key, { edition: structuredClone(edition), bytes }); this.bytes += bytes;
    }
    // Neither callers nor the kernel fold may mutate the memoized edition.
    return edition;
  }
}
