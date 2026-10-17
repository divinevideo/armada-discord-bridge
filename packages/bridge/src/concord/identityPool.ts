import { RelayPool } from "./pool";
/** Pools reading bridge-addressed inboxes must authenticate as that bridge. */
export function identityRelayPool(urls: string[], primarySk: Uint8Array): RelayPool {
  return new RelayPool(urls, { authSk: primarySk });
}
