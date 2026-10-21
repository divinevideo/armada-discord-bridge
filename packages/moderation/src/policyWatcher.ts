import { baseRekeyGroupKey, epochKeyCommitment, bytesToHex, channelsView, controlGroups, guestbookGroups, openWrap, parseEdition, snapshotAuthorities } from "@armada-bridge/concord-core";
import type { CommunityV2, StreamKeyView } from "@armada-bridge/concord-core";
import type { NostrEvent } from "nostr-tools/pure";
import type { RelayPool } from "../../bridge/src/concord/pool";
import type { CommunityPolicy, StreamDescriptor } from "./contracts";
import type { LocalIdentity } from "../../bridge/src/concord/signer";
import { verifyRecoveredRoot } from "./rekeyRecovery";
import { PolicyStore } from "./policyStore";
import { controlState, verifiedEvent } from "./relayPolicy";
export class PolicyWatcher {
  private generation = 0;
  private running?: Promise<CommunityPolicy>;
  constructor(readonly community: CommunityV2, private readonly store: PolicyStore, private readonly source: Pick<RelayPool, "queryStrict">, private readonly publicAuthors: string[], private readonly identity?: LocalIdentity, private readonly options: { readOnly?: boolean } = {}) {}
  async disconnected(): Promise<void> {
    this.generation++;
    // DB failure cannot keep admission alive: the validator uses that same DB.
    if (!this.options.readOnly) await this.store.invalidate(this.community.idHex).catch(() => {});
  }
  refresh(): Promise<CommunityPolicy> {
    if (this.running) return this.running;
    this.running = this.refreshOnce().finally(() => { this.running = undefined; });
    return this.running;
  }
  private async refreshOnce(): Promise<CommunityPolicy> {
    const generation = this.generation;
    const previous = await this.store.getPolicy(this.community.idHex);
    if (previous && this.community.rootEpoch > BigInt(previous.rootEpoch ?? "0")) {
      if (!this.identity) throw new Error("Rekey recovery identity required");
      await verifyRecoveredRoot(this.community, this.identity, previous, await this.store.rekeyEvents(this.community.idHex));
    }
    const groups = controlGroups(this.community);
    const descriptor = (plane: StreamDescriptor["plane"], key: StreamKeyView, epoch: bigint, channelId?: string, retiredAt?: number): StreamDescriptor => ({ communityId: this.community.idHex, plane, epoch: epoch.toString(), channelId, retiredAt, key: { pk: key.pk, convKey: key.convKey, restricted: key.restricted } });
    const controlStreams = groups.map((key, index) => descriptor("control", key, this.community.heldRoots[index].epoch));
    try {
      const fetched = await this.source.queryStrict([{ kinds: [1059], authors: groups.map((g) => g.pk), limit: 4096 }]);
      if (fetched.length >= 4096 || generation !== this.generation) throw new Error("Policy snapshot incomplete");
      const valid = new Map<string, NostrEvent>();
      for (const candidate of [...previous?.controlEvents ?? [], ...fetched]) {
        try {
          const event = verifiedEvent(candidate), group = groups.find((g) => g.pk === event.pubkey);
          if (!group) continue;
          parseEdition(openWrap(event, group));
          valid.set(event.id, event);
        } catch { /* Invalid candidates cannot become authority or poison a fold. */ }
      }
      const policy: CommunityPolicy = { communityId: this.community.idHex, owner: this.community.owner, ownerSalt: bytesToHex(this.community.ownerSalt), revision: (previous?.revision ?? 0) + 1, complete: true, rootEpoch: this.community.rootEpoch.toString(), validUntil: Date.now() + 30_000, controlStreams, controlEvents: [...valid.values()], banned: [], publicAuthors: [...new Set([this.community.owner, ...this.publicAuthors, ...previous?.publicAuthors ?? []])], snapshotAuthorities: [...snapshotAuthorities(this.community)] };
      const { folded } = controlState(policy);
      if (folded.incomplete.length) throw new Error("Control history incomplete");
      policy.banned = [...folded.banned];
      policy.publicAuthors = [...new Set([...policy.publicAuthors, ...folded.liveInviteLinks])];
      // Maintenance needs fresh authority without publishing an admission
      // grant: unsuccessful provenance recovery must leave exclusion intact.
      if (this.options.readOnly) {
        if (generation !== this.generation) throw new Error("Control disconnected during refresh");
        return policy;
      }
      const rekeys = this.community.heldRoots.map((root) => ({ ...descriptor("rekey", baseRekeyGroupKey(root.key, this.community.id, root.epoch + 1n), root.epoch + 1n), previousEpoch: root.epoch.toString(), previousCommit: bytesToHex(epochKeyCommitment(root.epoch, root.key)) }));
      const streams = [...controlStreams, ...rekeys, ...guestbookGroups(this.community).map((key, index) => descriptor("guestbook", key, this.community.heldRoots[index].epoch))];
      for (const channel of channelsView(this.community, folded).filter((c) => !folded.channels.get(c.idHex)?.metadata.private)) {
        for (const stream of channel.streams) streams.push(descriptor("chat", stream.group, stream.epoch, channel.idHex, stream.retiredAt));
      }
      if (generation !== this.generation) throw new Error("Control disconnected during refresh");
      await this.store.install(policy, streams, previous?.revision ?? 0);
      if (generation !== this.generation) { await this.disconnected(); throw new Error("Control disconnected during install"); }
      return (await this.store.getPolicy(this.community.idHex))!;
    } catch (error) { await this.disconnected(); throw error; }
  }
}
