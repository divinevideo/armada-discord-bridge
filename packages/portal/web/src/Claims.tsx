import { useEffect, useState } from "react";

import { api } from "./api";
import { NostrLogin } from "./NostrLogin";
import { useNostrLogin } from "./useNostrLogin";

interface ClaimTarget {
  communityId: string;
  communityName: string;
  guildId: string;
  messageCount: string;
  challenge: string;
}

interface ClaimResult {
  linkPublished: boolean;
  rolesGranted: string[];
  puppetNsec?: string;
}

/**
 * Claim your history (armada-history-claims-PLAN.md §3): your Discord session
 * proves which account you were, your Nostr login proves which Armada account
 * you are. One claim links the puppet, grants your imported roles, and can
 * hand over the puppet key.
 */
export function Claims(props: { onDone: () => void }) {
  const [targets, setTargets] = useState<ClaimTarget[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<(ClaimResult & { communityName: string }) | null>(null);
  const [keyConsent, setKeyConsent] = useState(false);
  const [selected, setSelected] = useState("");
  const login = useNostrLogin([]);

  useEffect(() => {
    void api<{ targets: ClaimTarget[] }>("/api/claims")
      .then((r) => {
        setTargets(r.targets);
        if (r.targets.length > 0) setSelected(r.targets[0].communityId);
      })
      .catch((e) => setError(String((e as Error).message)));
  }, []);

  async function claim() {
    const target = targets?.find((t) => t.communityId === selected);
    if (!target || !login.pk) return;
    setBusy(true);
    setError("");
    try {
      const signedProof = await login.signTemplate({
        kind: 30078,
        content: target.challenge,
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      });
      const res = await api<ClaimResult>("/api/claims", {
        method: "POST",
        body: JSON.stringify({
          communityId: target.communityId,
          npub: login.pk,
          signedProof,
          levels: { link: true, roles: true, key: keyConsent },
        }),
      });
      setResult({ ...res, communityName: target.communityName ?? "the community" });
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <div className="panel">
        <h2>Your history is now yours in {result.communityName}</h2>
        <table>
          <tbody>
            <tr>
              <td className="muted">profile link</td>
              <td>{result.linkPublished ? "published (visible when the Armada client supports it)" : "skipped"}</td>
            </tr>
            <tr>
              <td className="muted">roles</td>
              <td>
                {result.rolesGranted.length > 0
                  ? `${result.rolesGranted.length} role${result.rolesGranted.length === 1 ? "" : "s"} granted`
                  : "no roles matched (your Discord roles may not have carried over)"}
              </td>
            </tr>
          </tbody>
        </table>
        {result.puppetNsec && (
          <div className="disclosure">
            <p>
              Your puppet key. Import it into any Nostr client to post as your bridged
              Discord identity. It is shown once.
            </p>
            <p>
              <input type="text" readOnly value={result.puppetNsec} onFocus={(e) => e.currentTarget.select()} />
              <button
                className="ghost"
                style={{ marginTop: "0.4rem" }}
                onClick={() => void navigator.clipboard.writeText(result.puppetNsec!)}
              >
                Copy key
              </button>
            </p>
            <p className="muted">
              The bridge can always re-derive this key: it is shared custody, kept for
              mirroring your live Discord messages. It is not a transfer of ownership.
            </p>
          </div>
        )}
        <button onClick={props.onDone}>Back to dashboard</button>
      </div>
    );
  }

  return (
    <div className="panel">
      <h2>Claim your old account</h2>
      <p className="muted">
        If you talked on a Discord server that was bridged or imported, prove both
        accounts and your imported history becomes yours: your profile links to your
        real Armada account, and your Discord roles carry over.
      </p>
      {error && <p className="error">{error}</p>}

      {targets === null && <p className="muted">Looking up your bridged history…</p>}
      {targets !== null && targets.length === 0 && (
        <p>
          No bridged or imported communities found for this Discord account. Once a
          server you talked on is bridged, your history appears here.
        </p>
      )}
      {targets !== null && targets.length > 0 && (
        <>
          <h3>Your history</h3>
          {targets.map((t) => (
            <button
              key={t.communityId}
              className={`pick ${selected === t.communityId ? "on" : ""}`}
              onClick={() => setSelected(t.communityId)}
            >
              {t.communityName ?? "community"}{" "}
              <span className="muted">{t.messageCount} messages</span>
            </button>
          ))}

          <h3>Your Armada account</h3>
          <NostrLogin login={login} />

          <label className="consent">
            <input type="checkbox" checked={keyConsent} onChange={(e) => setKeyConsent(e.target.checked)} />
            <span>
              Also reveal my puppet key (shared custody; the bridge keeps using it to
              mirror my Discord messages)
            </span>
          </label>
          <div className="row" style={{ marginTop: "0.6rem" }}>
            <button disabled={!login.pk || !selected || busy} onClick={() => void claim()}>
              {busy ? "Claiming…" : "Claim my account"}
            </button>
            <button className="ghost" onClick={props.onDone}>Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}
