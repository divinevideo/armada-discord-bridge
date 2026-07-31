import { useEffect, useState } from "react";

import { api } from "./api";
import { NostrLogin } from "./NostrLogin";
import { useNostrLogin } from "./useNostrLogin";

interface ClaimContext {
  communityId: string;
  communityName: string | null;
  messageCount: string;
  claimed: boolean;
}

interface ClaimResult {
  linkPublished: boolean;
  rolesGranted: string[];
  puppetNsec?: string;
}

/**
 * Claim your old account (armada-history-claims-PLAN.md §3). You arrive from
 * a /claim bot link with a one-time code; the code proves you're the Discord
 * account that asked, your Nostr login proves which Armada account you are.
 */
export function Claims(props: { communityId: string; onDone: () => void }) {
  const [context, setContext] = useState<ClaimContext | null>(null);
  const [contextError, setContextError] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ClaimResult | null>(null);
  const [keyConsent, setKeyConsent] = useState(false);
  const login = useNostrLogin([]);

  useEffect(() => {
    void api<ClaimContext>(`/api/claims/${props.communityId}`)
      .then(setContext)
      .catch((e) => setContextError(String((e as Error).message)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.communityId]);

  async function claim() {
    if (!context || !login.pk) return;
    setBusy(true);
    setError("");
    try {
      const { challenge } = await api<{ challenge: string }>(
        `/api/claims/${props.communityId}/challenge?code=${encodeURIComponent(code.trim())}`,
      );
      const signedProof = await login.signTemplate({
        kind: 30078,
        content: challenge,
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      });
      const res = await api<ClaimResult>("/api/claims", {
        method: "POST",
        body: JSON.stringify({
          communityId: context.communityId,
          npub: login.pk,
          signedProof,
          code: code.trim(),
          levels: { link: true, roles: true, key: keyConsent },
        }),
      });
      setResult(res);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <div className="panel">
        <h2>Your history is now yours in {context?.communityName ?? "the community"}</h2>
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
        The bridge saw you on Discord. Enter the code the bot gave you and log in with
        your Armada key; your history there becomes yours.
      </p>
      {contextError && <p className="error">{contextError}</p>}
      {error && <p className="error">{error}</p>}

      {!context && !contextError && <p className="muted">Looking up the community…</p>}
      {context && (
        <>
          <h3>{context.communityName ?? "Community"}</h3>
          <p className="muted">
            {Number(context.messageCount) > 0
              ? `The bridge has ${context.messageCount} of your messages there.`
              : "Your messages appear here once you talk in a bridged channel."}
            {context.claimed && " You already claimed this one."}
          </p>

          <label>
            The code the bot gave you
            <input
              type="text"
              placeholder="e.g. a1b2c3d4"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>

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
            <button
              disabled={!login.pk || !code.trim() || busy || context.claimed}
              onClick={() => void claim()}
            >
              {busy ? "Claiming…" : context.claimed ? "Already claimed" : "Claim my account"}
            </button>
            <button className="ghost" onClick={props.onDone}>Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}
