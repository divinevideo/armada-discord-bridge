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

export class BlossomStore implements BlobPort {
  constructor(private readonly server: string) {}

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

    const base = this.server.replace(/\/$/, "");
    const res = await fetch(`${base}/upload`, {
      method: "PUT",
      headers: {
        Authorization: `Nostr ${Buffer.from(JSON.stringify(auth)).toString("base64")}`,
        "Content-Type": mime,
      },
      // Concrete ArrayBuffer slice: TS will not accept Uint8Array<ArrayBufferLike> as BodyInit.
      body: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
    });
    if (!res.ok) throw new Error(`blossom upload to ${base}: HTTP ${res.status}`);
    const descriptor = (await res.json().catch(() => ({}))) as { url?: string };
    return { url: descriptor.url || `${base}/${hash}`, sha256: hash };
  }
}
