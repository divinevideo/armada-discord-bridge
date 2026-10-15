import type { RoomTarget } from "./contracts";
import { HEX_ID } from "./relayPolicy";
export interface RemovalIndex {
  underBarrier?<T>(driver: PurgeDriver, work: (index: RemovalIndex, signal?: AbortSignal) => Promise<T>): Promise<T>;
  start(target: RoomTarget, decisionId: string): Promise<number>;
  ids(target: RoomTarget): Promise<string[]>;
  finish(decisionId: string, state: "verified" | "failed"): Promise<void>;
}
export interface PurgeDriver {
  barrier<T>(work: (signal?: AbortSignal) => Promise<T>): Promise<T>;
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
      const work = async (index: RemovalIndex, signal?: AbortSignal) => {
        signal?.throwIfAborted();
        stage = "index";
        carrierIds = await index.ids(target);
        signal?.throwIfAborted();
        stage = "delete";
        if (carrierIds.length) await this.driver.delete(carrierIds);
        signal?.throwIfAborted();
        stage = "rescan";
        const rescanned = await index.ids(target);
        signal?.throwIfAborted();
        if (rescanned.some((id) => !carrierIds.includes(id))) throw new Error("Carrier reconciliation changed");
        stage = "verify";
        if ((await this.driver.remaining(rescanned)).length) { stage = "carriers_remain"; throw new Error("Removal verification failed"); }
        signal?.throwIfAborted();
        stage = "record";
        await index.finish(decisionId, "verified");
      };
      if (this.index.underBarrier) await this.index.underBarrier(this.driver, work);
      else await this.driver.barrier((signal) => work(this.index, signal));
      state = "verified";
      stage = "complete";
    } catch { await this.index.finish(decisionId, "failed"); }
    return { decisionId, target, policyRevision: revision, state, carrierIds, stage };
  }
}
