import type { SourceOrder } from "./decisions";
export type DecisionSource = { caseId: string; priorDecisionId?: never } | { caseId?: never; priorDecisionId: string };
export interface ReversalContext {
  decisionId: string; caseId: string; communityId: string; channelId: string; rumorId: string; author: string;
  action: "ban_member"; discordGuildConfirmed: boolean;
}
export interface ReversalInput {
  executionId: string; action: "unban_member"; reason: string; scope: "community";
  discordGuildConfirmed: boolean; sourceOrder: SourceOrder;
}
export interface DiscordRestriction {
  state: "present" | "absent" | "unknown" | "not_applicable"; checkedAt: string | null; code: string;
}
export interface LifecycleStatus {
  decisionId: string; appealState: "none" | "open" | "closed"; closedAt: string | null;
  auditDeleteAfter: string | null; auditAvailable: boolean;
}
export interface HoldStatus { holdId: string; caseId: string; holdUntil: string; releasedAt: string | null }
export type LifecycleCapability = "manage_moderation_records" | "view_held_evidence";
