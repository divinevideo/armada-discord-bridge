/**
 * At-rest sealing for per-bridge secrets: AES-256-GCM under the portal KMS
 * key (PORTAL_SEAL_KEY). Layout: 12-byte IV || 16-byte tag || ciphertext.
 *
 * {@link digest} covers the other half of the problem: secrets the database
 * has to look up BY VALUE (one-time codes) can't be sealed, since the same
 * input must land on the same row every time. Those are stored as a keyed
 * HMAC instead — same key, same property that a database-only leak yields
 * nothing usable, but deterministic so an equality lookup still works.
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

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

/**
 * Keyed, deterministic digest of a lookup secret. `label` domain-separates
 * the uses, so a digest minted for one kind of secret can never be replayed
 * as another. The label is length-prefixed rather than merely delimited, so
 * no pair of (label, value) can smear across the boundary into another.
 */
export function digest(keyHex: string, label: string, value: string): string {
  return createHmac("sha256", keyFrom(keyHex))
    .update(`${label.length}:${label}:${value}`, "utf8")
    .digest("hex");
}

/**
 * The stored form of a /claim code. The code is a real credential — whoever
 * presents it claims that Discord user's puppet identity and roles — so the
 * table holds only this.
 */
export function claimCodeDigest(keyHex: string, code: string): string {
  return digest(keyHex, "claim-code", code.trim().toLowerCase());
}

function keyFrom(hex: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("PORTAL_SEAL_KEY must be 64 lowercase hex chars");
  return Buffer.from(hex, "hex");
}
