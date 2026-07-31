import { useEffect, useRef, useState } from "react";
import * as nip19 from "nostr-tools/nip19";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";

import { api } from "./api";
import type { ImportPlanView, ImportStatus, OwnerSignTemplate } from "./api";
import { fetchNostrProfile } from "./nostrProfile";
import type { NostrProfile } from "./nostrProfile";

interface GuildOpt { id: string; name: string }

/** NIP-07 browser extension surface, if one is installed. */
interface Nip07 {
  getPublicKey(): Promise<string>;
  signEvent(template: EventTemplate): Promise<NostrEvent>;
}
declare global {
  interface Window { nostr?: Nip07 }
}

const STEPS = ["server", "review", "import", "done"] as const;

/* Lucide log-in, the glyph Armada's login dialog leads with. */
function LogInGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
      <polyline points="10 17 15 12 10 7" />
      <line x1="15" x2="3" y1="12" y2="12" />
    </svg>
  );
}

export function ImportWizard(props: { guilds: GuildOpt[]; onDone: () => void; onCancel: () => void }) {
  const [step, setStep] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [guildId, setGuildId] = useState("");
  const [installUrl, setInstallUrl] = useState("");
  const [importId, setImportId] = useState("");
  const [plan, setPlan] = useState<ImportPlanView | null>(null);

  // The user's Armada account. The nsec never leaves this component: local
  // signing only, exactly like logging into Armada itself.
  const [ownerPk, setOwnerPk] = useState("");
  const [signWith, setSignWith] = useState<"extension" | "nsec" | null>(null);
  const [nsec, setNsec] = useState("");
  const [signingStep, setSigningStep] = useState("");

  const [defaultRelays, setDefaultRelays] = useState<string[]>([]);
  const [relayList, setRelayList] = useState<string[]>([]);
  const [editRelays, setEditRelays] = useState(false);
  const [newRelay, setNewRelay] = useState("");
  const [consent, setConsent] = useState(false);
  const [status, setStatus] = useState<ImportStatus | null>(null);

  async function preview(gid: string) {
    setBusy(true);
    setError("");
    setInstallUrl("");
    try {
      const res = await api<
        | { present: false; installUrl: string }
        | { present: true; importId: string; plan: ImportPlanView; defaultRelays: string[] }
      >("/api/imports", { method: "POST", body: JSON.stringify({ guildId: gid }) });
      if (!res.present) {
        setInstallUrl(res.installUrl);
        setStep(1);
        return;
      }
      setImportId(res.importId);
      setPlan(res.plan);
      setDefaultRelays(res.defaultRelays);
      setRelayList(res.defaultRelays);
      setStep(1);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  function toggleChannel(discordId: string, field: "selected" | "bridge") {
    if (!plan) return;
    setPlan({
      ...plan,
      channels: plan.channels.map((c) => {
        if (c.discordId !== discordId) return c;
        if (field === "selected") {
          const selected = !c.selected;
          return { ...c, selected, bridge: selected && c.bridge };
        }
        return { ...c, bridge: !c.bridge };
      }),
    });
  }

  // ── Armada account ─────────────────────────────────────────────────────────

  const [loginError, setLoginError] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const [profile, setProfile] = useState<NostrProfile>({});

  // Stay logged in like Armada does: the login (method + local key) persists
  // in this browser's localStorage and restores on mount.
  const LOGIN_STORE = "portal:nostr-login";
  useEffect(() => {
    const raw = localStorage.getItem(LOGIN_STORE);
    if (!raw) return;
    try {
      const stored = JSON.parse(raw) as { method: "extension" | "nsec"; nsec?: string };
      if (stored.method === "nsec" && stored.nsec) {
        const decoded = nip19.decode(stored.nsec);
        if (decoded.type !== "nsec") throw new Error("bad stored key");
        setNsec(stored.nsec);
        setOwnerPk(getPublicKey(decoded.data as Uint8Array));
        setSignWith("nsec");
      } else if (stored.method === "extension" && window.nostr) {
        void window.nostr.getPublicKey().then((pk) => {
          setOwnerPk(pk);
          setSignWith("extension");
        }).catch(() => localStorage.removeItem(LOGIN_STORE));
      }
    } catch {
      localStorage.removeItem(LOGIN_STORE);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Look up the owner's kind 0 (avatar + name) once they log in.
  useEffect(() => {
    if (!ownerPk) {
      setProfile({});
      return;
    }
    let stale = false;
    void fetchNostrProfile(ownerPk, defaultRelays).then((p) => {
      if (!stale) setProfile(p);
    });
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerPk]);

  async function connectExtension() {
    setLoginError("");
    setLoggingIn(true);
    try {
      const pk = await window.nostr!.getPublicKey();
      setOwnerPk(pk);
      setSignWith("extension");
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
    setOwnerPk(getPublicKey(sk));
    setSignWith("nsec");
    localStorage.setItem(LOGIN_STORE, JSON.stringify({ method: "nsec", nsec: nsec.trim() }));
  }

  function disconnect() {
    setOwnerPk("");
    setSignWith(null);
    setNsec("");
    localStorage.removeItem(LOGIN_STORE);
  }

  async function signTemplate(template: EventTemplate): Promise<NostrEvent> {
    if (signWith === "extension") return window.nostr!.signEvent(template);
    const sk = nsecKey();
    if (!sk) throw new Error("your key is no longer available; unlock again");
    return finalizeEvent(template, sk);
  }

  // ── Prepare → sign → confirm ───────────────────────────────────────────────

  async function startImport() {
    if (!plan || !ownerPk) return;
    setBusy(true);
    setError("");
    try {
      setSigningStep("preparing the community…");
      const prep = await api<{ ownerPk: string; templates: OwnerSignTemplate[] }>(
        `/api/imports/${importId}/prepare`,
        {
          method: "POST",
          body: JSON.stringify({
            ownerNpub: ownerPk,
            relays: editRelays ? relayList : undefined,
            channels: plan.channels.map((c) => ({ discordId: c.discordId, selected: c.selected, bridge: c.bridge })),
          }),
        },
      );
      const signedEvents: NostrEvent[] = [];
      for (let i = 0; i < prep.templates.length; i++) {
        setSigningStep(`signing as owner (${i + 1} / ${prep.templates.length})…`);
        signedEvents.push(await signTemplate(prep.templates[i].template));
      }
      setSigningStep("");
      await api(`/api/imports/${importId}/confirm`, {
        method: "POST",
        body: JSON.stringify({ signedEvents }),
      });
      setStep(2);
    } catch (e) {
      setSigningStep("");
      setError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  // Poll import progress while the pipeline runs.
  const polling = step === 2;
  const importIdRef = useRef(importId);
  importIdRef.current = importId;
  useEffect(() => {
    if (!polling) return;
    let stop = false;
    const tick = async () => {
      try {
        const res = await api<ImportStatus>(`/api/imports/${importIdRef.current}`);
        if (stop) return;
        setStatus(res);
        setPlan(res.plan);
        if (res.status === "done") {
          setStep(3);
          return;
        }
      } catch {
        // transient; keep polling
      }
      if (!stop) setTimeout(() => void tick(), 2000);
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [polling]);

  // The community is ready: open it in Armada in a new tab (once). A popup
  // blocker may eat this; the button below covers that case.
  const openedRef = useRef(false);
  useEffect(() => {
    if (step !== 3 || !status?.inviteUrl || openedRef.current) return;
    openedRef.current = true;
    window.open(status.inviteUrl, "_blank", "noopener");
  }, [step, status?.inviteUrl]);

  async function retry() {
    setError("");
    try {
      await api(`/api/imports/${importId}/retry`, { method: "POST" });
      setStatus(null);
    } catch (e) {
      setError(String((e as Error).message));
    }
  }

  const newRelayValid = /^wss?:\/\/\S+$/.test(newRelay.trim()) && !relayList.includes(newRelay.trim());

  function addRelay() {
    const relay = newRelay.trim();
    if (!newRelayValid) return;
    setRelayList([...relayList, relay]);
    setNewRelay("");
  }

  const selectedCount = plan?.channels.filter((c) => c.selected).length ?? 0;
  const bridgeCount = plan?.channels.filter((c) => c.selected && c.bridge).length ?? 0;
  const publishedCount = plan?.channels.filter((c) => c.selected && c.publishedAt).length ?? 0;
  const wiredCount = plan?.channels.filter((c) => c.bridgeId).length ?? 0;
  const npub = ownerPk ? nip19.npubEncode(ownerPk) : "";

  return (
    <div>
      <div className="steps">
        {STEPS.map((name, i) => (
          <span key={name} className={i === step ? "on" : i < step ? "done" : ""}>
            {i + 1} {name}
          </span>
        ))}
      </div>
      {error && <p className="error">{error}</p>}

      {step === 0 && (
        <div className="panel">
          <h2>Pick the Discord server to import</h2>
          <p className="muted">
            The whole server becomes a brand-new Armada community that you own: channels,
            roles, and settings. Only servers where you hold Manage Server are listed.
          </p>
          {props.guilds.map((g) => (
            <button key={g.id} className={`pick ${guildId === g.id ? "on" : ""}`} onClick={() => setGuildId(g.id)}>
              {g.name} <span className="mono muted">{g.id}</span>
            </button>
          ))}
          <div className="row" style={{ marginTop: "0.75rem" }}>
            <button disabled={!guildId || busy} onClick={() => void preview(guildId)}>
              {busy ? "Reading the server…" : "Continue"}
            </button>
            <button className="ghost" onClick={props.onCancel}>Cancel</button>
          </div>
        </div>
      )}

      {step === 1 && installUrl && (
        <div className="panel">
          <h2>Install the bot</h2>
          <p>The bridge bot is not in this server yet; it does the reading and the mirroring.</p>
          <a className="btn" href={installUrl} target="_blank" rel="noreferrer">Install the bot</a>
          <button className="ghost" style={{ marginLeft: "0.6rem" }} onClick={() => void preview(guildId)}>
            I installed it, re-check
          </button>
        </div>
      )}

      {step === 1 && plan && (
        <div className="panel">
          <h2>Review the import: {plan.communityName}</h2>
          <p className="muted">
            {selectedCount} channels will be created, {bridgeCount} of them live-bridged;{" "}
            {plan.roles.length} roles come across.
          </p>

          <h3>Your Armada account</h3>
          <p className="muted">
            The new community is owned by your key, like any community you create in
            Armada. Your key signs the founding events here in your browser and never
            reaches our server.
          </p>
          {!ownerPk && (
            <div className="login-card clip-corner-lg">
              <div className="login-head">
                <div className="login-glyph clip-corner-lg"><LogInGlyph /></div>
                <h2 className="login-title">Log in with Nostr</h2>
              </div>
              <p className="login-note">
                New here?{" "}
                <a href="https://armada.buzz" target="_blank" rel="noreferrer">Create account</a>
              </p>
              {typeof window !== "undefined" && window.nostr && (
                <>
                  <button
                    type="button"
                    className="login-ext clip-corner-lg"
                    disabled={loggingIn}
                    onClick={() => void connectExtension()}
                  >
                    {loggingIn ? "Logging in..." : "Log in with Extension"}
                  </button>
                  <div className="login-or">
                    <span className="line" />
                    <span>or</span>
                    <span className="line" />
                  </div>
                </>
              )}
              <form
                className="login-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  unlockNsec();
                }}
              >
                <input
                  type="password"
                  className={`login-input clip-corner-lg ${loginError ? "err" : ""}`}
                  placeholder="nsec1…"
                  autoComplete="off"
                  value={nsec}
                  onChange={(e) => {
                    setNsec(e.target.value);
                    if (loginError) setLoginError("");
                  }}
                />
                {loginError && <p className="login-error">{loginError}</p>}
                <button type="submit" className="login-submit clip-corner-lg" disabled={!nsec.trim() || loggingIn}>
                  Log in
                </button>
              </form>
            </div>
          )}
          {ownerPk && (
            <div className="login-user clip-corner-lg">
              {profile.picture ? (
                <img className="login-avatar" src={profile.picture} alt="" referrerPolicy="no-referrer" />
              ) : (
                <div className="login-glyph clip-corner-lg"><LogInGlyph /></div>
              )}
              <div className="who">
                <div className="name">
                  {profile.name ?? "Logged in"}
                  <span className="muted"> · {signWith === "extension" ? "extension" : "your key"}</span>
                </div>
                <div className="id">{npub}</div>
              </div>
              <button className="ghost" onClick={disconnect}>Log out</button>
            </div>
          )}

          <h3>Channels</h3>
          {plan.channels.map((c) => (
            <div className="row" key={c.discordId} style={{ gap: "0.6rem" }}>
              <label className="consent" style={{ flex: 1 }}>
                <input type="checkbox" checked={c.selected} onChange={() => toggleChannel(c.discordId, "selected")} />
                <span>
                  #{c.name}
                  {c.category && <span className="muted"> · {c.category}</span>}
                  {c.kind === "voice" && <span className="muted"> · voice room</span>}
                </span>
              </label>
              {c.bridgeable && (
                <label className="consent">
                  <input
                    type="checkbox"
                    checked={c.bridge}
                    disabled={!c.selected}
                    onChange={() => toggleChannel(c.discordId, "bridge")}
                  />
                  <span className="muted">bridge live</span>
                </label>
              )}
            </div>
          ))}

          {plan.roles.length > 0 && (
            <>
              <h3>Roles</h3>
              {plan.roles.map((r) => (
                <p key={r.discordId} style={{ margin: "0.15rem 0" }}>
                  {r.name}
                  {r.dropped.length > 0 && (
                    <span className="muted"> · loses {r.dropped.join(", ")}</span>
                  )}
                </p>
              ))}
            </>
          )}

          <h3>Not imported</h3>
          {plan.skipped.map((s, i) => (
            <p key={i} className="muted" style={{ margin: "0.15rem 0" }}>
              {s.name} — {s.reason}
            </p>
          ))}

          <h3>Relays</h3>
          {relayList.map((r) => (
            <div className="row" key={r} style={{ gap: "0.6rem" }}>
              <span className="mono muted" style={{ flex: 1 }}>{r}</span>
              {editRelays && (
                <button className="ghost" onClick={() => setRelayList(relayList.filter((x) => x !== r))}>
                  Remove
                </button>
              )}
            </div>
          ))}
          {!editRelays && (
            <p className="muted">
              The standard Armada relay set.{" "}
              <button className="ghost" onClick={() => setEditRelays(true)}>Change relays</button>
            </p>
          )}
          {editRelays && (
            <>
              <div className="row" style={{ gap: "0.6rem" }}>
                <input
                  type="text"
                  placeholder="wss://relay.example.com"
                  value={newRelay}
                  style={{ flex: 1 }}
                  onChange={(e) => setNewRelay(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addRelay();
                  }}
                />
                <button className="ghost" disabled={!newRelayValid} onClick={addRelay}>
                  Add relay
                </button>
              </div>
              <p className="muted">
                <button
                  className="ghost"
                  onClick={() => {
                    setRelayList(defaultRelays);
                    setEditRelays(false);
                    setNewRelay("");
                  }}
                >
                  Reset to the standard set
                </button>
              </p>
            </>
          )}

          <div className="disclosure">
            You will sign {""}four founding events as the community owner. The bridge
            keeps an Admin role for running the import and the live bridges; you can
            revoke it from Armada at any time. Bridged channels leave end-to-end
            encryption: their messages are mirrored to Discord in plaintext. The import
            runs once and cannot be undone from here.
          </div>
          <label className="consent">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>I understand the ownership model and that bridged channels are not end-to-end encrypted.</span>
          </label>
          <div className="row" style={{ marginTop: "0.6rem" }}>
            <button
              disabled={!consent || !ownerPk || selectedCount === 0 || relayList.length === 0 || busy}
              onClick={() => void startImport()}
            >
              {signingStep || "Import the server"}
            </button>
            <button className="ghost" onClick={props.onCancel}>Cancel</button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="panel">
          <h2>Importing…</h2>
          <p className="status active" style={{ display: "inline-block" }}>
            {status?.status ?? "starting"}
          </p>
          <table>
            <tbody>
              <tr>
                <td className="muted">community</td>
                <td>{plan?.checkpoints?.communityIdHex ? "minted, owned by your key" : "minting…"}</td>
              </tr>
              <tr>
                <td className="muted">channels published</td>
                <td className="mono">{publishedCount} / {selectedCount}</td>
              </tr>
              <tr>
                <td className="muted">roles published</td>
                <td className="mono">
                  {plan?.roles.filter((r) => r.publishedAt).length ?? 0} / {plan?.roles.length ?? 0}
                </td>
              </tr>
              <tr>
                <td className="muted">bridges wired</td>
                <td className="mono">{wiredCount} / {bridgeCount}</td>
              </tr>
            </tbody>
          </table>
          {status?.status === "failed" && (
            <>
              <p className="error">{status.statusDetail ?? "import failed"}</p>
              <button onClick={() => void retry()}>Retry from where it stopped</button>
            </>
          )}
        </div>
      )}

      {step === 3 && (
        <div className="panel">
          <h2>{plan?.communityName} is live on Armada</h2>
          <p>
            {publishedCount} channels created, {wiredCount} live bridges running, owned
            by <span className="mono">{npub ? `${npub.slice(0, 16)}…` : "your key"}</span>.
            Your community should have opened in a new tab; if it did not:
          </p>
          {status?.inviteUrl && (
            <p>
              <a className="btn" href={status.inviteUrl} target="_blank" rel="noreferrer">
                Open your community in Armada
              </a>
            </p>
          )}
          {status?.inviteUrl && (
            <p>
              <input type="text" readOnly value={status.inviteUrl} onFocus={(e) => e.currentTarget.select()} />
              <button
                className="ghost"
                style={{ marginTop: "0.4rem" }}
                onClick={() => void navigator.clipboard.writeText(status.inviteUrl!)}
              >
                Copy invite link
              </button>
            </p>
          )}
          {plan && plan.skipped.length > 0 && (
            <>
              <h3>Not imported</h3>
              {plan.skipped.map((s, i) => (
                <p key={i} className="muted" style={{ margin: "0.15rem 0" }}>
                  {s.name} — {s.reason}
                </p>
              ))}
            </>
          )}
          <button onClick={props.onDone}>Go to dashboard</button>
        </div>
      )}
    </div>
  );
}
