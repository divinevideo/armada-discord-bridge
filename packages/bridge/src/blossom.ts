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
import type { BlobPort } from "./router";

const KIND_BLOSSOM_AUTH = 24242;

export class BlossomStore implements BlobPort {
  constructor(private readonly server: string) {}

  async download(url: string, maxBytes: number): Promise<{ data: Uint8Array; mime: string }> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download ${url}: HTTP ${res.status}`);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > maxBytes) throw new Error(`download ${url}: ${declared} bytes exceeds cap`);
    const data = new Uint8Array(await res.arrayBuffer());
    if (data.length > maxBytes) throw new Error(`download ${url}: body exceeds cap`);
    return { data, mime: res.headers.get("content-type")?.split(";")[0] || "application/octet-stream" };
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
