import { useCallback, useEffect, useState } from "react";

import { api } from "./api";
import type { BridgeSummary, Me } from "./api";
import { Wizard } from "./Wizard";

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [view, setView] = useState<"dashboard" | "wizard">("dashboard");

  const refresh = useCallback(() => {
    void api<Me>("/api/me").then(setMe).catch(() => setMe({ user: null, devLogin: false }));
  }, []);
  useEffect(refresh, [refresh]);

  return (
    <>
      <header className="masthead">
        <div>
          <h1><span className="word">armada</span> bridge</h1>
          <p className="muted">Connect a Discord channel to an Armada community channel.</p>
        </div>
        {me?.user && (
          <div className="row">
            <span className="muted">{me.user.username}</span>
            <button className="ghost" onClick={() => void api("/api/auth/logout", { method: "POST" }).then(refresh)}>
              Sign out
            </button>
          </div>
        )}
      </header>

      {!me && <p className="muted">Loading…</p>}
      {me && !me.user && <SignIn devLogin={me.devLogin} onSignedIn={refresh} />}
      {me?.user && view === "dashboard" && (
        <Dashboard onNew={() => setView("wizard")} />
      )}
      {me?.user && view === "wizard" && (
        <Wizard
          guilds={me.guilds ?? []}
          onDone={() => setView("dashboard")}
          onCancel={() => setView("dashboard")}
        />
      )}
    </>
  );
}

function SignIn(props: { devLogin: boolean; onSignedIn: () => void }) {
  return (
    <div className="panel">
      <h2>What this does, plainly</h2>
      <p>
        A bridge mirrors messages between one Discord channel and one Armada channel.
        Discord users appear in Armada as individual bridged identities; Armada members
        appear in Discord with their own name and avatar. Setup takes both sides'
        consent: yours here, and an in-channel confirmation from the Armada community.
      </p>
      <p className="disclosure" style={{ marginTop: "0.75rem" }}>
        The tradeoff, stated up front: bridged messages leave Armada's end-to-end
        encryption and land on Discord's servers in plaintext.
      </p>
      <div className="row" style={{ marginTop: "1rem" }}>
        <a className="btn" href="/api/auth/discord">Sign in with Discord</a>
        {props.devLogin && (
          <button className="ghost" onClick={() => void api("/api/auth/dev", { method: "POST" }).then(props.onSignedIn)}>
            Dev login
          </button>
        )}
      </div>
    </div>
  );
}

function Dashboard(props: { onNew: () => void }) {
  const [bridges, setBridges] = useState<BridgeSummary[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    void api<{ bridges: BridgeSummary[] }>("/api/bridges")
      .then((r) => setBridges(r.bridges))
      .catch((e) => setError(String((e as Error).message)));
  }, []);
  useEffect(load, [load]);

  async function act(id: string, action: "pause" | "resume" | "unlink") {
    if (action === "unlink" && !confirm("Unlink this bridge? Its keys are destroyed; the puppet identities are unrecoverable.")) return;
    try {
      await api(`/api/bridges/${id}/${action}`, { method: "POST" });
      load();
    } catch (e) {
      setError(String((e as Error).message));
    }
  }

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2>Your bridges</h2>
        <button onClick={props.onNew}>Create a bridge</button>
      </div>
      {error && <p className="error">{error}</p>}
      {bridges === null && <p className="muted">Loading…</p>}
      {bridges?.length === 0 && (
        <div className="panel">
          <p className="muted">No bridges yet. Create one to link a Discord channel with an Armada channel.</p>
        </div>
      )}
      {bridges?.map((b) => (
        <div className="panel" key={b.bridge_id}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <strong>{b.community_name ?? "(unnamed community)"}</strong>
            <span className={`status ${b.status}`}>{b.status}</span>
          </div>
          <table>
            <tbody>
              <tr>
                <td className="muted">discord channel</td>
                <td className="mono">{b.discord_channel_id ?? "—"}</td>
              </tr>
              <tr>
                <td className="muted">armada channel</td>
                <td className="mono">{b.concord_channel_id ? `${b.concord_channel_id.slice(0, 16)}…` : "—"}</td>
              </tr>
              <tr>
                <td className="muted">bridge npub (for mods)</td>
                <td className="mono">{b.primary_pk ? `${b.primary_pk.slice(0, 16)}…` : "—"}</td>
              </tr>
              <tr>
                <td className="muted">messages bridged</td>
                <td className="mono">{b.bridged_count}</td>
              </tr>
              {b.status_detail && (
                <tr>
                  <td className="muted">detail</td>
                  <td>{b.status_detail}</td>
                </tr>
              )}
            </tbody>
          </table>
          <div className="row" style={{ marginTop: "0.6rem" }}>
            {b.status === "active" && <button className="ghost" onClick={() => void act(b.bridge_id, "pause")}>Pause</button>}
            {(b.status === "paused" || b.status === "severed") && (
              <button className="ghost" onClick={() => void act(b.bridge_id, "resume")}>Resume</button>
            )}
            <button className="danger" onClick={() => void act(b.bridge_id, "unlink")}>Unlink</button>
          </div>
        </div>
      ))}
    </div>
  );
}
