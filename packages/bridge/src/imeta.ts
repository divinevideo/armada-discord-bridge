/**
 * NIP-92 `imeta` as Armada actually writes and reads it.
 *
 * Two facts about that dialect are not visible from NIP-92 alone, and both are
 * why bridged media arrived broken:
 *
 *  - **Every attachment sent from a Concord community is client-encrypted.**
 *    The blob at `url` is AES-256-GCM ciphertext with the GCM tag appended,
 *    and the key rides in the same tag under the Vector/0xChat field names
 *    (`encryption-algorithm` / `decryption-key` / `decryption-nonce`, plus
 *    `ox`, the SHA-256 of the *plaintext*). A bridge that reads only `url` and
 *    `size` downloads ciphertext and uploads it to Discord as an image.
 *
 *  - **Discord types an upload by its FILENAME, not by any metadata.** Blossom
 *    URLs are content-addressed, so the last path segment is frequently a bare
 *    hex hash; naming the file after it produces an unpreviewable attachment
 *    no matter how correct the `m` field is. The `m` field is the one that
 *    knows, because on an encrypted attachment the served content-type
 *    describes the ciphertext.
 *
 * The parse is deliberately more permissive than the write side (base64 key
 * material, absent `ox`) and the *validity* check is deliberately separate
 * from it — see {@link isSupportedEncryption}.
 */

import { createDecipheriv } from "node:crypto";

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

/** AES-GCM blob-encryption parameters carried in an imeta tag. */
export interface ImetaEncryption {
  /** Algorithm as sent, lowercased. Only `aes-gcm` can be applied. */
  algorithm: string;
  /** AES-256 key, normalised to lowercase hex, or the raw value if undecodable. */
  key: string;
  /** AES-GCM nonce/IV as lowercase hex. Armada and 0xChat use 16 bytes, not 12. */
  nonce: string;
  /** SHA-256 (hex) of the PLAINTEXT. Absent on a forward whose sender lacked it. */
  ox?: string;
}

/** Bytes of GCM authentication tag WebCrypto appends to its ciphertext. */
const GCM_TAG_BYTES = 16;

/**
 * Space-delimited imeta fields -> a map.
 *
 * Split on the FIRST space only: `waveform` and `alt` carry multi-word values,
 * and a field with no space at all is not a field.
 */
export function imetaFields(tag: string[]): Map<string, string> {
  const fields = new Map<string, string>();
  for (const part of tag.slice(1)) {
    const space = part.indexOf(" ");
    if (space === -1) continue;
    fields.set(part.slice(0, space), part.slice(space + 1));
  }
  return fields;
}

/**
 * Encryption parameters, or undefined when the attachment is plaintext.
 *
 * A value comes back whenever `encryption-algorithm` is present at all — even
 * for an algorithm we cannot apply or key material that is malformed. Folding
 * "unreadable" back into undefined is what would make the caller treat the
 * blob as plaintext and hand ciphertext to Discord, which is the bug.
 */
export function parseImetaEncryption(fields: Map<string, string>): ImetaEncryption | undefined {
  const algorithm = fields.get("encryption-algorithm");
  if (!algorithm) return undefined;
  const ox = fields.get("ox");
  return {
    algorithm: algorithm.toLowerCase(),
    key: decodeKeyMaterial(fields.get("decryption-key") ?? ""),
    nonce: decodeKeyMaterial(fields.get("decryption-nonce") ?? ""),
    ox: ox && isHex(ox, 64) ? ox.toLowerCase() : undefined,
  };
}

/** Whether {@link decryptBlob} can actually apply these parameters. */
export function isSupportedEncryption(enc: ImetaEncryption | undefined): boolean {
  if (!enc) return false;
  return enc.algorithm === "aes-gcm" && isHex(enc.key, 64) && isHex(enc.nonce) && enc.nonce.length > 0;
}

/**
 * Ciphertext -> plaintext, verified against `ox`.
 *
 * The layout is WebCrypto's own output uploaded verbatim: `ciphertext ‖ 16-byte
 * tag`, which Node wants handed over as two separate pieces. The nonce is 16
 * bytes rather than the usual 12 (0xChat compatibility), so the IV length is
 * taken from the tag rather than assumed.
 *
 * Throws rather than returning the bytes on any failure. A blob whose `ox`
 * does not match has been swapped underneath the sender's key, and the bridge
 * would be re-publishing it into Discord under that sender's name.
 */
export function decryptBlob(data: Uint8Array, enc: ImetaEncryption): Uint8Array {
  if (data.length < GCM_TAG_BYTES) throw new Error("ciphertext is shorter than its GCM tag");
  const split = data.length - GCM_TAG_BYTES;
  const decipher = createDecipheriv("aes-256-gcm", hexToBytes(enc.key), hexToBytes(enc.nonce));
  decipher.setAuthTag(data.subarray(split));
  const plaintext = Buffer.concat([decipher.update(data.subarray(0, split)), decipher.final()]);
  if (enc.ox && bytesToHex(sha256(plaintext)) !== enc.ox) {
    throw new Error("decrypted attachment does not match its `ox` hash");
  }
  return new Uint8Array(plaintext);
}

/**
 * Extensions, by MIME. Only the types worth rendering inline are listed; the
 * fallback derives one from the subtype, which is right far more often than it
 * is wrong (`application/zip` -> `zip`) and harmless when it is.
 */
const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "application/pdf": "pdf",
};

/** The reverse, for URLs we can only type by looking at them. */
const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  wav: "audio/wav",
};

/** Trailing `.ext` of a filename or path segment. */
const EXTENSION_RE = /\.[A-Za-z0-9]{1,8}$/;

/** Longest filename handed to Discord's multipart upload. */
const MAX_FILENAME_CHARS = 96;

export function extensionForMime(mime: string): string | undefined {
  const type = mime.split(";")[0].trim().toLowerCase();
  const known = EXTENSION_BY_MIME[type];
  if (known) return known;
  const subtype = type.split("/")[1]?.split("+")[0];
  return subtype && /^[a-z0-9]{1,8}$/.test(subtype) ? subtype : undefined;
}

/** The MIME a URL's extension implies, for media types only. */
export function mimeFromUrl(url: string): string | undefined {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return undefined;
  }
  const ext = EXTENSION_RE.exec(path.split("/").pop() ?? "");
  return ext ? MIME_BY_EXTENSION[ext[0].slice(1).toLowerCase()] : undefined;
}

/**
 * Append the extension a content-addressed blob URL is missing.
 *
 * Blossom names blobs `/<sha256>`, and BUD-01 requires servers to serve the
 * same blob at `/<sha256>.<ext>` — so this costs nothing and buys the two
 * things that read the URL rather than the metadata: Discord's link unfurl and
 * Armada's extension sniffing, which is the only signal a bare URL in message
 * content carries.
 */
export function withExtension(url: string, mime: string): string {
  const ext = extensionForMime(mime);
  if (!ext) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const last = parsed.pathname.split("/").pop() ?? "";
  if (last === "" || EXTENSION_RE.test(last)) return url;
  parsed.pathname = `${parsed.pathname}.${ext}`;
  return parsed.toString();
}

/**
 * A filename Discord will accept and can type, out of values the sender chose.
 *
 * Both candidate sources — the imeta `name` field and the URL's last path
 * segment — are remote input that lands in a multipart `filename=` header, so
 * anything outside a conservative set is replaced: a quote or a newline there
 * rewrites the part header, and a `/` or a leading `..` is a path the far side
 * may honour. The extension is then supplied from the MIME if the name lacks
 * one, because that is what decides whether Discord previews the upload.
 */
export function attachmentFilename(url: string, mime: string, declared?: string): string {
  const raw = declared?.trim() || lastPathSegment(url) || "file";
  const cleaned = raw.replace(/[^\w.\- ]+/g, "_").replace(/^[.\s]+/, "").trim();
  const name = cleaned === "" ? "file" : cleaned;
  const found = EXTENSION_RE.exec(name);
  const ext = found ? found[0] : `.${extensionForMime(mime) ?? "bin"}`;
  const stem = (found ? name.slice(0, -ext.length) : name).slice(0, MAX_FILENAME_CHARS - ext.length);
  return `${stem === "" ? "file" : stem}${ext}`;
}

function lastPathSegment(url: string): string {
  try {
    return new URL(url).pathname.split("/").pop() ?? "";
  } catch {
    return "";
  }
}

/**
 * Hex validator (even length, hex digits only), optionally of a fixed length.
 *
 * Deliberately NOT a `value is string` type predicate: the false branch of one
 * applied to a `string` narrows to `never`, which is how the base64 fallback in
 * {@link decodeKeyMaterial} stopped compiling.
 */
function isHex(value: string | undefined, len?: number): boolean {
  if (!value) return false;
  if (len !== undefined && value.length !== len) return false;
  return value.length % 2 === 0 && /^[0-9a-f]+$/i.test(value);
}

/**
 * Normalise key material to lowercase hex.
 *
 * Neither NIP-17 nor the NIP-94 encryption extension pins an encoding, and
 * senders in the wild use both hex and base64 — Armada's own reader accepts
 * either, so a bridge that accepted only hex would refuse to decrypt an image
 * that every other member of the channel can see. Hex wins the ambiguity: a
 * base64 string that happens to be all-hex decodes to the wrong LENGTH, which
 * {@link isSupportedEncryption} then rejects rather than silently mis-keying.
 *
 * Returns the value unchanged when it is neither, so the caller can still tell
 * the attachment claims to be encrypted.
 */
function decodeKeyMaterial(value: string): string {
  const trimmed = value.trim();
  if (isHex(trimmed)) return trimmed.toLowerCase();
  if (!/^[A-Za-z0-9+/\-_]+={0,2}$/.test(trimmed)) return value;
  const bytes = Buffer.from(trimmed.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return bytes.length > 0 ? bytes.toString("hex") : value;
}
