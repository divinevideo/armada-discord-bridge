/**
 * At-rest sealing for per-bridge secrets: AES-256-GCM under the portal KMS
 * key (PORTAL_SEAL_KEY). Layout: 12-byte IV || 16-byte tag || ciphertext.
 *
 * This module used to carry a keyed-HMAC `digest` alongside, for secrets the
 * database had to look up BY VALUE — /claim codes were the only such secret,
 * and they went with the claim feature. Anything needing that shape again
 * wants a length-prefixed, domain-separated label; see git history.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export function seal(keyHex: string, plaintext: string): Buffer {
  const key = keyFrom(keyHex);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

export function unseal(keyHex: string, sealed: Uint8Array): string {
  const key = keyFrom(keyHex);
  const buf = Buffer.from(sealed);
  if (buf.length < 29) throw new Error("sealed blob too short");
  const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}

function keyFrom(hex: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("PORTAL_SEAL_KEY must be 64 lowercase hex chars");
  return Buffer.from(hex, "hex");
}
