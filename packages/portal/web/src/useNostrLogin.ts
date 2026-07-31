import { useEffect, useState } from "react";
import * as nip19 from "nostr-tools/nip19";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";

import { fetchNostrProfile } from "./nostrProfile";
import type { NostrProfile } from "./nostrProfile";

/** NIP-07 browser extension surface, if one is installed. */
interface Nip07 {
  getPublicKey(): Promise<string>;
  signEvent(template: EventTemplate): Promise<NostrEvent>;
}
declare global {
  interface Window { nostr?: Nip07 }
}

const LOGIN_STORE = "portal:nostr-login";

/**
 * Armada-style key login, shared by the import wizard and the claims page:
 * nsec paste or NIP-07 extension, local signing only, persisted in
 * localStorage so the login survives reloads.
 */
export function useNostrLogin(defaultRelays: string[]) {
  const [pk, setPk] = useState("");
  const [method, setMethod] = useState<"extension" | "nsec" | null>(null);
  const [nsec, setNsec] = useState("");
  const [profile, setProfile] = useState<NostrProfile>({});
  const [loginError, setLoginError] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);

  // Restore a previous login on mount.
  useEffect(() => {
    const raw = localStorage.getItem(LOGIN_STORE);
    if (!raw) return;
    try {
      const stored = JSON.parse(raw) as { method: "extension" | "nsec"; nsec?: string };
      if (stored.method === "nsec" && stored.nsec) {
        const decoded = nip19.decode(stored.nsec);
        if (decoded.type !== "nsec") throw new Error("bad stored key");
        setNsec(stored.nsec);
        setPk(getPublicKey(decoded.data as Uint8Array));
        setMethod("nsec");
      } else if (stored.method === "extension" && window.nostr) {
        void window.nostr.getPublicKey()
          .then((k) => {
            setPk(k);
            setMethod("extension");
          })
          .catch(() => localStorage.removeItem(LOGIN_STORE));
      }
    } catch {
      localStorage.removeItem(LOGIN_STORE);
    }
  }, []);

  // Look up the owner's kind 0 (avatar + name) once they log in.
  useEffect(() => {
    if (!pk) {
      setProfile({});
      return;
    }
    let stale = false;
    void fetchNostrProfile(pk, defaultRelays).then((p) => {
      if (!stale) setProfile(p);
    });
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pk]);

  async function connectExtension() {
    setLoginError("");
    setLoggingIn(true);
    try {
      const k = await window.nostr!.getPublicKey();
      setPk(k);
      setMethod("extension");
      localStorage.setItem(LOGIN_STORE, JSON.stringify({ method: "extension" }));
    } catch (e) {
      setLoginError(String((e as Error).message));
    } finally {
      setLoggingIn(false);
    }
  }

  function nsecKey(): Uint8Array | null {
    try {
      const decoded = nip19.decode(nsec.trim());
      return decoded.type === "nsec" ? (decoded.data as Uint8Array) : null;
    } catch {
      return null;
    }
  }

  function unlockNsec() {
    setLoginError("");
    const sk = nsecKey();
    if (!sk) {
      setLoginError("Enter a secret key starting with nsec1.");
      return;
    }
    setPk(getPublicKey(sk));
    setMethod("nsec");
    localStorage.setItem(LOGIN_STORE, JSON.stringify({ method: "nsec", nsec: nsec.trim() }));
  }

  function disconnect() {
    setPk("");
    setMethod(null);
    setNsec("");
    localStorage.removeItem(LOGIN_STORE);
  }

  async function signTemplate(template: EventTemplate): Promise<NostrEvent> {
    if (method === "extension") return window.nostr!.signEvent(template);
    const sk = nsecKey();
    if (!sk) throw new Error("your key is no longer available; unlock again");
    return finalizeEvent(template, sk);
  }

  return {
    pk,
    npub: pk ? nip19.npubEncode(pk) : "",
    method,
    nsec,
    setNsec,
    profile,
    loginError,
    setLoginError,
    loggingIn,
    connectExtension,
    unlockNsec,
    disconnect,
    signTemplate,
  };
}
