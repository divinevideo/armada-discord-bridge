import type { NostrEvent } from "nostr-tools/pure";
import type { StreamKeyView } from "@armada-bridge/concord-core";

export interface RoomTarget { communityId: string; channelId: string; rumorId: string }
export type DeliveryTarget = "divine_relay" | "concord" | "discord";
export type DeliveryState = "pending" | "acknowledged" | "verified" | "failed" | "not_applicable";
export type ReadStreamKey = Readonly<Omit<StreamKeyView, "sk">> & { sk?: never };
export interface StreamDescriptor {
  communityId: string;
  channelId?: string;
  plane: "chat" | "control" | "guestbook" | "rekey";
  epoch: string;
  retiredAt?: number;
  previousEpoch?: string;
  previousCommit?: string;
  key: ReadStreamKey;
}
export interface CommunityPolicy {
  communityId: string;
  owner: string;
  ownerSalt: string;
  revision: number;
  complete: boolean;
  rootEpoch?: string;
  rekeyPending?: boolean;
  validUntil: number;
  controlStreams: StreamDescriptor[];
  controlEvents: NostrEvent[];
  banned: string[];
  publicAuthors: string[];
  snapshotAuthorities: string[];
}
export interface AdmissionContext {
  policy?: CommunityPolicy;
  stream?: StreamDescriptor;
  /** AUTH never substitutes for the author verified inside a stream wrap. */
  authed?: string;
  publicAuthorKnown?: boolean;
  now(): number;
  isRemoved(target: RoomTarget): Promise<boolean>;
  authorOf(target: RoomTarget): Promise<string | undefined>;
}
export interface AdmissionResult { action: "accept" | "reject"; id: string; msg?: string }
export interface CarrierRecord extends RoomTarget {
  eventId: string;
  author: string;
  kind: number;
  expiresAt?: number;
  policyRevision: number;
  targetRumorIds?: string[];
}
