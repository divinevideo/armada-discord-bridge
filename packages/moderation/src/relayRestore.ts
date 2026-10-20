import type { NostrEvent } from "nostr-tools/pure";
import { HEX_ID } from "./relayPolicy";
export interface RestorePolicy {
  assertRestoreReady(floors: Record<string, number>): Promise<void>;
  admitRestored(event: NostrEvent): Promise<boolean>;
}
export interface RestoreDriver {
  scan(): AsyncIterable<NostrEvent>;
  delete(ids: string[]): Promise<void>;
}
/** Run while the public listener is stopped, using policy restored independently
 * of the relay backup. No ready marker is produced on partial reconciliation. */
export async function reconcileRestore(policy: RestorePolicy, driver: RestoreDriver, floors: Record<string, number>) {
  if (!Object.keys(floors).length || Object.entries(floors).some(([id, revision]) => !HEX_ID.test(id) || !Number.isSafeInteger(revision) || revision < 1)) throw new Error("Explicit recovery policy floors required");
  await policy.assertRestoreReady(floors);
  let retained = 0, removed = 0;
  for await (const event of driver.scan()) {
    if (!HEX_ID.test(event.id)) throw new Error("Invalid restored carrier");
    if (await policy.admitRestored(event)) retained++;
    else { await driver.delete([event.id]); removed++; }
  }
  await policy.assertRestoreReady(floors);
  return { retained, removed };
}
