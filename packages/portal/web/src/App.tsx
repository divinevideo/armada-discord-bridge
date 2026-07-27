import { useCallback, useEffect, useState } from "react";

import { api } from "./api";
import type { BridgeSummary, Me } from "./api";
import { Wizard } from "./Wizard";

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [view, setView] = useState<"dashboard" | "wizard">("dashboard");

  const refresh = useCallback(() => {
    void api<Me>("/api/me").then(setMe).catch(() => setMe({ user: null, devLogin: false, discordConfigured: false }));
  }, []);
  useEffect(refresh, [refresh]);

  return (
    <>
      <header className="masthead">
        <div className="brand">
          <LogoMark />
          <h1>Bridge Portal</h1>
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
      <p className="muted tagline">Connect a Discord channel to an Armada community channel.</p>

      {!me && <p className="muted">Loading…</p>}
      {me && !me.user && <SignIn devLogin={me.devLogin} discordConfigured={me.discordConfigured} onSignedIn={refresh} />}
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

function SignIn(props: { devLogin: boolean; discordConfigured: boolean; onSignedIn: () => void }) {
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
        {props.discordConfigured ? (
          <a className="btn" href="/api/auth/discord">Sign in with Discord</a>
        ) : (
          <span className="muted">
            Discord OAuth is not configured on this server (set DISCORD_CLIENT_ID and
            DISCORD_CLIENT_SECRET, restart the API).
          </span>
        )}
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
      {bridges !== null && (
      <div className="frame">
      {bridges.length === 0 && (
        <p className="muted">No bridges yet. Create one to link a Discord channel with an Armada channel.</p>
      )}
      {bridges.map((b) => (
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
      )}
    </div>
  );
}

/* Armada crest (public/logo-mark.svg inlined so currentColor takes the theme). */
function LogoMark() {
  return (
    <svg viewBox="0 0 256 256" fill="none" aria-hidden="true" className="logo-mark">
      <path
        d="M64 16 H232 a8 8 0 0 1 8 8 V192 L192 240 H24 a8 8 0 0 1 -8 -8 V64 Z"
        fill="none" stroke="currentColor" strokeWidth="10"
      />
      <path d="M128 56 L180 162 H158 L128 100 L98 162 H76 Z" fill="currentColor" />
      <path d="M106 134 H150 L158 150 H98 Z" fill="var(--logo-bg, #0e0a12)" />
      <g stroke="currentColor" strokeLinecap="round" opacity="0.55">
        <path d="M88 184 H168" strokeWidth="6" />
        <path d="M104 200 H152" strokeWidth="4" opacity="0.7" />
      </g>
    </svg>
  );
}
