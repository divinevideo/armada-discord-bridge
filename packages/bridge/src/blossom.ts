/**
 * Blossom blob rehosting (BUD-02): Discord CDN attachments are signed URLs
 * that expire in ~24 hours, so bridged media is uploaded to a Blossom server
 * and the durable URL rides in the rumor instead. Uploads are authorized by a
 * kind 24242 event signed by the sending puppet, so blobs are attributable to
 * the same identity as the message.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import type { LocalIdentity } from "./concord/signer";
import { safeFetch } from "./net";
import type { BlobPort } from "./router";

const KIND_BLOSSOM_AUTH = 24242;

/**
 * How long one server gets to accept an upload before the next is tried.
 *
 * The upload used to be a bare `fetch` with no deadline, so a server that
 * accepted the connection and then stalled held the message — and every one
 * queued behind it — indefinitely.
 */
const UPLOAD_TIMEOUT_MS = 30_000;

/**
 * Parse `BLOSSOM_SERVER`: one URL, or several comma-separated in preference
 * order. Blank entries and trailing slashes are dropped.
 */
export function blossomServers(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter((s) => s !== "");
}

export class BlossomStore implements BlobPort {
  private readonly servers: string[];

  /**
   * `servers` is tried in order on every upload. One host was the whole
   * story before, and blossom.primal.net spent days answering 500 and 401 —
   * hundreds of Discord attachments crossed as CDN links that expire in a
   * day. A second host turns that outage into a slower upload instead.
   */
  constructor(servers: string | string[]) {
    this.servers = typeof servers === "string" ? blossomServers(servers) : servers;
    if (this.servers.length === 0) throw new Error("BlossomStore needs at least one server");
  }

  /**
   * Fetch a blob named by someone else.
   *
   * Every caller of this passes a URL the bridge did not choose — an `imeta`
   * tag on an inbound rumor, or a media URL off a Discord embed, which is an
   * OpenGraph value from whatever page was linked. It therefore goes through
   * {@link safeFetch}: http(s) only (Bun's `fetch` will happily resolve
   * `file:///proc/self/environ` otherwise, and this process holds the seal
   * key), public hosts only, redirects re-checked, and the cap enforced by a
   * running counter instead of a `content-length` the remote server chose.
   */
  async download(url: string, maxBytes: number): Promise<{ data: Uint8Array; mime: string }> {
    const { body, mime } = await safeFetch(url, maxBytes);
    return { data: body, mime };
  }

  async upload(
    data: Uint8Array,
    mime: string,
    author: LocalIdentity,
  ): Promise<{ url: string; sha256: string }> {
    const hash = bytesToHex(sha256(data));
    const now = Math.floor(Date.now() / 1000);
    // One auth event covers every server: BUD-02 scopes it by `x`, not by host
    // (a `server` tag is optional, and adding one would pin it to a single host).
    const auth = await author.signer.signEvent({
      kind: KIND_BLOSSOM_AUTH,
      content: "Upload bridged Discord attachment",
      created_at: now,
      tags: [
        ["t", "upload"],
        ["x", hash],
        ["expiration", String(now + 300)],
      ],
    });
    const authorization = `Nostr ${Buffer.from(JSON.stringify(auth)).toString("base64")}`;
    // Concrete ArrayBuffer slice: TS will not accept Uint8Array<ArrayBufferLike> as BodyInit.
    const body = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;

    const failures: string[] = [];
    for (const base of this.servers) {
      try {
        const res = await fetch(`${base}/upload`, {
          method: "PUT",
          headers: { Authorization: authorization, "Content-Type": mime },
          body,
          signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const descriptor = (await res.json().catch(() => ({}))) as { url?: string };
        return { url: descriptor.url || `${base}/${hash}`, sha256: hash };
      } catch (error) {
        failures.push(`${base}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`blossom upload failed on every server (${failures.join("; ")})`);
  }
}
