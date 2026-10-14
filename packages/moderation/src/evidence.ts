import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type postgres from "postgres";
import { checkChannelBinding, openWrap } from "@armada-bridge/concord-core";
import type { NostrEvent } from "nostr-tools/pure";
import type { RoomTarget } from "./contracts";
import { PolicyStore } from "./policyStore";
import { controlState, HEX_ID, verifiedEvent } from "./relayPolicy";
export class EvidenceCipher {
  constructor(private readonly key: Uint8Array, readonly retentionSeconds: number, private readonly maxBytes: number) {
    if (key.length !== 32 || !Number.isSafeInteger(retentionSeconds) || retentionSeconds < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Evidence encryption and existing retention policy required");
  }
  seal(binding: string, value: unknown): Buffer {
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > this.maxBytes) throw new Error("Evidence exceeds limit");
    const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(binding));
    return Buffer.concat([nonce, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
  }
  open(binding: string, value: Uint8Array): any {
    if (value.length > this.maxBytes + 28 || value.length < 28) throw new Error("Invalid evidence");
    const bytes = Buffer.from(value), cipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(binding)); cipher.setAuthTag(bytes.subarray(-16));
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString("utf8"));
  }
}
export interface VerifiedEvidence { target: RoomTarget; author: string; content: string; kind: number; createdAt: number; carrier: NostrEvent }
export class RelayEvidenceResolver {
  constructor(private readonly sql: postgres.Sql, private readonly fetchCarriers: (ids: string[]) => Promise<NostrEvent[]>) {}
  async resolve(target: RoomTarget): Promise<VerifiedEvidence> {
    if (!Object.values(target).every((id) => HEX_ID.test(id))) throw new Error("Invalid report target");
    const policy = await new PolicyStore(this.sql).getPolicy(target.communityId);
    if (!policy || !policy.complete || policy.validUntil <= Date.now()) throw new Error("Room policy unavailable");
    const folded = controlState(policy).folded;
    const channel = folded.channels.get(target.channelId);
    if (folded.incomplete.length || !channel || channel.deleted || channel.metadata.private) throw new Error("Room not reportable");
    const rows = await this.sql`SELECT c.event_id, c.author, s.pubkey, s.epoch, s.read_key, s.restricted
      FROM moderation.carriers c JOIN moderation.streams s ON s.community_id = c.community_id AND s.channel_id = c.channel_id
      WHERE c.community_id = ${target.communityId} AND c.channel_id = ${target.channelId} AND c.rumor_id = ${target.rumorId}
      ORDER BY c.indexed_at DESC LIMIT 32`;
    const events = await this.fetchCarriers(rows.map((row) => row.event_id as string));
    for (const candidate of events) {
      const row = rows.find((entry) => entry.event_id === candidate.id && entry.pubkey === candidate.pubkey);
      if (!row) continue;
      try {
        const carrier = verifiedEvent(candidate);
        const opened = openWrap(carrier, { pk: row.pubkey, convKey: new Uint8Array(row.read_key), restricted: row.restricted });
        checkChannelBinding(opened, target.channelId, BigInt(row.epoch));
        if (opened.rumorId !== target.rumorId || opened.author !== row.author || ![9, 1111].includes(opened.kind)) continue;
        const expiry = opened.tags.find((tag) => tag[0] === "expiration");
        if (expiry && Number(expiry[1]) * 1000 <= Date.now()) continue;
        return { target, author: opened.author, content: opened.content, kind: opened.kind, createdAt: opened.createdAt, carrier };
      } catch { /* Try another verified carrier; never persist caller-provided evidence. */ }
    }
    throw new Error("Verified message unavailable");
  }
}
