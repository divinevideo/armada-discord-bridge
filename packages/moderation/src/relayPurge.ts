import type { RoomTarget } from "./contracts";
import { HEX_ID } from "./relayPolicy";
export interface RemovalIndex {
  start(target: RoomTarget, decisionId: string): Promise<number>;
  ids(target: RoomTarget): Promise<string[]>;
  finish(decisionId: string, state: "verified" | "failed"): Promise<void>;
}
export interface PurgeDriver {
  barrier<T>(work: () => Promise<T>): Promise<T>;
  delete(ids: string[]): Promise<void>;
  remaining(ids: string[]): Promise<string[]>;
}
export class RelayPurger {
  constructor(private readonly index: RemovalIndex, private readonly driver: PurgeDriver) {}
  async removeFromRelay(target: RoomTarget, decisionId: string): Promise<{ decisionId: string; target: RoomTarget; policyRevision: number; state: "verified" | "failed"; carrierIds: string[]; stage: string }> {
    if (!Object.values(target).every((value) => HEX_ID.test(value)) || !/^[0-9a-f-]{36}$/.test(decisionId)) throw new Error("Invalid removal target");
    // Commit the tombstone before waiting for the writer's file lock. Reversing
    // those locks deadlocks a writer already inside the admission transaction.
    const revision = await this.index.start(target, decisionId);
    let state: "verified" | "failed" = "failed";
    let carrierIds: string[] = [];
    let stage = "barrier";
    try {
      await this.driver.barrier(async () => {
        stage = "index";
        carrierIds = await this.index.ids(target);
        stage = "delete";
        if (carrierIds.length) await this.driver.delete(carrierIds);
        stage = "rescan";
        const rescanned = await this.index.ids(target);
        if (rescanned.some((id) => !carrierIds.includes(id))) throw new Error("Carrier reconciliation changed");
        stage = "verify";
        if ((await this.driver.remaining(rescanned)).length) { stage = "carriers_remain"; throw new Error("Removal verification failed"); }
        stage = "record";
        await this.index.finish(decisionId, "verified");
        state = "verified";
        stage = "complete";
      });
    } catch { await this.index.finish(decisionId, "failed"); }
    return { decisionId, target, policyRevision: revision, state, carrierIds, stage };
  }
}
