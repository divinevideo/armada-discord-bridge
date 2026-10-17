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
export interface VerifiedEvidence { target: RoomTarget; author: string; content: string; kind: number; createdAt: number; carrier: NostrEvent; editCarrier?: NostrEvent; editedAt?: number }
export class RelayEvidenceResolver {
  constructor(private readonly sql: postgres.Sql, private readonly fetchCarriers: (ids: string[]) => Promise<NostrEvent[]>) {}
  async resolve(target: RoomTarget): Promise<VerifiedEvidence> {
    if (!Object.values(target).every((id) => HEX_ID.test(id))) throw new Error("Invalid report target");
    const policy = await new PolicyStore(this.sql).getPolicy(target.communityId);
    if (!policy || !policy.complete || policy.validUntil <= Date.now()) throw new Error("Room policy unavailable");
    const folded = controlState(policy).folded;
    const channel = folded.channels.get(target.channelId);
    if (folded.incomplete.length || !channel || channel.deleted || channel.metadata.private) throw new Error("Room not reportable");
    const legacy = await this.sql`SELECT 1 FROM moderation.carriers WHERE community_id = ${target.communityId}
      AND channel_id = ${target.channelId} AND kind = 3302 AND NOT targets_indexed LIMIT 1`;
    if (legacy.length) throw new Error("Carrier references require verified reindexing");
    const rows = await this.sql`SELECT c.event_id, c.author, c.rumor_id, c.kind FROM moderation.carriers c
      WHERE c.community_id = ${target.communityId} AND c.channel_id = ${target.channelId}
        AND (c.rumor_id = ${target.rumorId} OR (c.kind = 3302 AND c.target_rumor_ids @> ARRAY[${target.rumorId}]::text[]))
        AND (c.expires_at IS NULL OR c.expires_at > clock_timestamp())
        AND NOT EXISTS (SELECT 1 FROM moderation.tombstones t WHERE t.community_id = c.community_id AND t.channel_id = c.channel_id AND t.rumor_id = c.rumor_id)
      ORDER BY c.indexed_at DESC, c.event_id LIMIT 129`;
    if (rows.length > 128) throw new Error("Evidence carrier bound exceeded");
    const streams = await this.sql`SELECT pubkey, epoch, read_key, restricted FROM moderation.streams
      WHERE community_id = ${target.communityId} AND channel_id = ${target.channelId} AND plane = 'chat'`;
    const events = await this.fetchCarriers(rows.map((row) => row.event_id as string));
    let original: VerifiedEvidence | undefined;
    const edits: { rumorId: string; author: string; content: string; ms: number; createdAt: number; carrier: NostrEvent }[] = [];
    const verifiedEdits = new Set<string>();
    for (const candidate of events) {
      const row = rows.find((entry) => entry.event_id === candidate.id);
      const stream = streams.find((entry) => entry.pubkey === candidate.pubkey);
      if (!row || !stream) continue;
      try {
        const carrier = verifiedEvent(candidate);
        const opened = openWrap(carrier, { pk: stream.pubkey, convKey: new Uint8Array(stream.read_key), restricted: stream.restricted });
        checkChannelBinding(opened, target.channelId, BigInt(stream.epoch));
        if (opened.rumorId !== row.rumor_id || opened.author !== row.author || opened.kind !== row.kind) continue;
        const expiry = opened.tags.find((tag) => tag[0] === "expiration");
        if (expiry && Number(expiry[1]) * 1000 <= Date.now()) continue;
        if ([9, 1111].includes(opened.kind) && opened.rumorId === target.rumorId) original = { target, author: opened.author, content: opened.content, kind: opened.kind, createdAt: opened.createdAt, carrier };
        else if (opened.kind === 3302 && opened.tags.find((tag) => tag[0] === "e")?.[1] === target.rumorId) {
          verifiedEdits.add(opened.rumorId);
          edits.push({ rumorId: opened.rumorId, author: opened.author, content: opened.content, ms: opened.ms, createdAt: opened.createdAt, carrier });
        }
      } catch { /* Try another verified carrier; never persist caller-provided evidence. */ }
    }
    if (original) {
      // Missing or unverifiable indexed edits cannot silently show stale text.
      if (rows.some((row) => row.kind === 3302 && !verifiedEdits.has(row.rumor_id))) throw new Error("Verified edit unavailable");
      const authored = edits.filter((edit) => edit.author === original!.author).sort((a, b) => b.ms - a.ms);
      const latest = authored[0];
      if (latest) {
        if (authored.some((edit) => edit.ms === latest.ms && edit.content !== latest.content)) throw new Error("Ambiguous message edit");
        return { ...original, content: latest.content, editCarrier: latest.carrier, editedAt: latest.createdAt };
      }
      return original;
    }
    throw new Error("Verified message unavailable");
  }
}
