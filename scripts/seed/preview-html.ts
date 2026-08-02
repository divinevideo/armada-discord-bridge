/**
 * Render a seed script to a self-contained HTML file for review in a browser.
 *
 *   bun run scripts/seed/preview-html.ts <key>   # default: discord-refugees
 *
 * Pure offline render, no relay, nothing published. Avatars/banners load from
 * their URLs so you see exactly what each profile looks like. Output goes to
 * scripts/seed/out/<key>.html.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { nip19 } from "nostr-tools";

import { seed as discordRefugees } from "./content/discord-refugees";
import { seed as edh } from "./content/edh";
import { seed as gaming } from "./content/gaming";
import { seed as healthFitness } from "./content/health-fitness";
import { seed as neurodivergents } from "./content/neurodivergents";
import { seed as theBasement } from "./content/the-basement";
import { seed as vegans } from "./content/vegans";
import { loadOrCreateMaster } from "./keystore";
import { PERSONAS, personaById, personasFor, profileMetadata } from "./personas";
import { schedule } from "./schedule";
import { deriveSock } from "./sock";
import type { CommunitySeed, Persona } from "./types";

const SEEDS: Record<string, CommunitySeed> = {
  "discord-refugees": discordRefugees,
  gaming,
  "the-basement": theBasement,
  edh,
  neurodivergents,
  "health-fitness": healthFitness,
  vegans,
};

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Stable name color per persona (Discord-style role colors). */
function hue(id: string): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}
const nameColor = (id: string): string => `hsl(${hue(id)} 65% 68%)`;

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString("en-US", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  });
}

function shortNpub(master: string, id: string): string {
  const npub = nip19.npubEncode(deriveSock(master, id).pk);
  return `${npub.slice(0, 12)}…${npub.slice(-4)}`;
}

function memberCard(p: Persona, master: string): string {
  const meta = profileMetadata(p);
  const display = p.displayName ?? p.handle;
  const badges = p.communities.map((c) => `<span class="badge">${esc(c)}</span>`).join(" ");
  return `
  <div class="card">
    <div class="banner" style="background-image:url('${esc(meta.banner!)}')"></div>
    <div class="card-body">
      <img class="card-avatar" src="${esc(meta.picture!)}" alt="" loading="lazy">
      <div class="card-name" style="color:${nameColor(p.id)}">${esc(display)}</div>
      <div class="card-handle">@${esc(p.handle)} · <span class="style-tag">${p.style}</span></div>
      <div class="card-npub">${shortNpub(master, p.id)}</div>
      <div class="card-bio">${esc(p.about)}</div>
      <div class="card-badges">${badges}</div>
    </div>
  </div>`;
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function ytId(url: string): string | undefined {
  return url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{11})/)?.[1];
}

/** Escape, then turn bare URLs into links. */
function linkify(text: string): string {
  return esc(text).replace(/(https?:\/\/[^\s]+)/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
}

function embedHtml(embed: NonNullable<CommunitySeed["messages"][number]["embed"]>): string {
  if (embed.type === "image") {
    return `<div class="embed"><img class="embed-img" src="${esc(embed.url)}" loading="lazy" alt=""></div>`;
  }
  if (embed.type === "video") {
    const id = ytId(embed.url);
    const thumb = id ? `<img class="embed-thumb" src="https://img.youtube.com/vi/${id}/hqdefault.jpg" loading="lazy" alt="">` : "";
    return `<a class="embed embed-video" href="${esc(embed.url)}" target="_blank" rel="noopener">${thumb}<div class="embed-meta"><span class="play">▶</span><div><div class="embed-title">${esc(embed.title ?? "Video")}</div><div class="embed-domain">${esc(domainOf(embed.url))}</div></div></div></a>`;
  }
  return `<a class="embed embed-link" href="${esc(embed.url)}" target="_blank" rel="noopener"><div class="embed-meta"><span class="globe">🔗</span><div><div class="embed-title">${esc(embed.title ?? domainOf(embed.url))}</div><div class="embed-domain">${esc(embed.url)}</div></div></div></a>`;
}

function reactionsHtml(reactions: NonNullable<CommunitySeed["messages"][number]["reactions"]>): string {
  const byEmoji = new Map<string, string[]>();
  for (const r of reactions) {
    const names = byEmoji.get(r.emoji) ?? [];
    names.push(personaById(r.from)?.handle ?? r.from);
    byEmoji.set(r.emoji, names);
  }
  const pills = [...byEmoji.entries()]
    .map(([emoji, names]) => `<span class="react" title="${esc(names.join(", "))}">${emoji} ${names.length}</span>`)
    .join(" ");
  return `<div class="reacts">${pills}</div>`;
}

function render(seed: CommunitySeed, master: string): string {
  const members = personasFor(seed.key);
  const idToIndex = new Map<string, number>();
  seed.messages.forEach((m, i) => {
    if (m.id) idToIndex.set(m.id, i);
  });

  const scheduled = schedule(seed);

  // Group by channel in first-seen order.
  const order: string[] = [];
  const byChannel = new Map<string, typeof scheduled>();
  for (const item of scheduled) {
    const ch = item.m.channel;
    if (!byChannel.has(ch)) {
      byChannel.set(ch, []);
      order.push(ch);
    }
    byChannel.get(ch)!.push(item);
  }

  const anchorId = (ch: string): string => `ch-${ch.replace(/[^a-z0-9]+/gi, "-")}`;

  const nav = order
    .map((ch) => `<a href="#${anchorId(ch)}"># ${esc(ch)} <span class="count">${byChannel.get(ch)!.length}</span></a>`)
    .join("");

  const channelSections = order
    .map((ch) => {
      const msgs = byChannel
        .get(ch)!
        .map(({ m, index, ms }) => {
          const p = personaById(m.from)!;
          const meta = profileMetadata(p);
          const display = p.displayName ?? p.handle;

          let replyPreview = "";
          if (m.replyTo !== undefined) {
            const pIdx = typeof m.replyTo === "string" ? idToIndex.get(m.replyTo) : m.replyTo;
            const parent = pIdx !== undefined ? seed.messages[pIdx] : undefined;
            if (parent) {
              const pp = personaById(parent.from)!;
              const kind = m.replyMode === "thread" ? "thread" : "reply";
              const snippet = parent.text || (parent.embed ? `[${parent.embed.type}]` : "");
              replyPreview = `<div class="reply-ctx ${kind}"><span class="reply-kind">${kind === "thread" ? "⤷ in thread" : "↩ replying to"}</span> <b style="color:${nameColor(pp.id)}">${esc(pp.displayName ?? pp.handle)}</b>: ${esc(snippet.slice(0, 90))}</div>`;
            }
          }

          return `
      <div class="msg ${m.replyTo !== undefined ? "is-reply" : ""}" id="m${index}">
        <img class="avatar" src="${esc(meta.picture!)}" alt="" loading="lazy">
        <div class="msg-body">
          ${replyPreview}
          <div class="msg-head">
            <span class="msg-name" style="color:${nameColor(p.id)}">${esc(display)}</span>
            <span class="msg-handle">@${esc(p.handle)}</span>
            <span class="msg-ts">${fmtTime(ms)}</span>
          </div>
          ${m.text ? `<div class="msg-text">${linkify(m.text)}</div>` : ""}
          ${m.embed ? embedHtml(m.embed) : ""}
          ${m.reactions?.length ? reactionsHtml(m.reactions) : ""}
        </div>
      </div>`;
        })
        .join("");
      return `<section class="channel" id="${anchorId(ch)}"><h2># ${esc(ch)}</h2>${msgs}</section>`;
    })
    .join("");

  const roster = members.map((p) => memberCard(p, master)).join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(seed.name)} · seed preview</title>
<style>
  :root { --bg:#16181c; --bg2:#1d1f24; --bg3:#24272e; --line:#2c2f36; --text:#dfe3e8; --muted:#8a919c; --accent:#4a9d7f; }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; background:var(--bg); color:var(--text); }
  .layout { display:grid; grid-template-columns:220px 1fr 300px; min-height:100vh; }
  .side { background:var(--bg2); border-right:1px solid var(--line); padding:16px 10px; position:sticky; top:0; height:100vh; overflow:auto; }
  .side h1 { font-size:15px; margin:4px 8px 14px; letter-spacing:.2px; }
  .side .note { color:var(--muted); font-size:12px; margin:0 8px 14px; }
  .side a { display:flex; justify-content:space-between; gap:8px; color:var(--muted); text-decoration:none; padding:6px 8px; border-radius:6px; }
  .side a:hover { background:var(--bg3); color:var(--text); }
  .side a .count { color:var(--muted); font-size:11px; background:var(--bg); padding:0 6px; border-radius:8px; }
  main { padding:8px 24px 80px; max-width:900px; }
  .channel { border-top:1px solid var(--line); padding-top:8px; margin-top:20px; }
  .channel h2 { position:sticky; top:0; background:var(--bg); padding:12px 0 8px; margin:0 0 6px; font-size:16px; color:#fff; z-index:2; }
  .msg { display:flex; gap:12px; padding:6px 8px; border-radius:8px; }
  .msg:hover { background:var(--bg2); }
  .msg.is-reply { border-left:2px solid var(--line); margin-left:10px; }
  .avatar { width:40px; height:40px; border-radius:50%; object-fit:cover; background:var(--bg3); flex:0 0 auto; }
  .msg-body { min-width:0; }
  .msg-head { display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; }
  .msg-name { font-weight:600; }
  .msg-handle { color:var(--muted); font-size:12px; }
  .msg-ts { color:var(--muted); font-size:11px; }
  .msg-text { white-space:pre-wrap; word-wrap:break-word; margin-top:1px; }
  .msg-text a { color:var(--accent); text-decoration:none; } .msg-text a:hover { text-decoration:underline; }
  .embed { margin-top:6px; max-width:440px; }
  .embed-img { max-width:100%; max-height:340px; border-radius:8px; display:block; border:1px solid var(--line); }
  .embed-link, .embed-video { display:block; text-decoration:none; color:inherit; border:1px solid var(--line); border-left:3px solid var(--accent); border-radius:8px; background:var(--bg2); overflow:hidden; }
  .embed-thumb { width:100%; max-height:220px; object-fit:cover; display:block; }
  .embed-meta { display:flex; gap:10px; align-items:center; padding:10px 12px; }
  .embed-title { font-weight:600; font-size:13px; }
  .embed-domain { color:var(--muted); font-size:11px; word-break:break-all; }
  .embed .play, .embed .globe { font-size:16px; }
  .reply-ctx { color:var(--muted); font-size:12px; margin-bottom:3px; padding-left:2px; }
  .reply-ctx .reply-kind { color:var(--accent); }
  .reacts { margin-top:5px; display:flex; gap:5px; flex-wrap:wrap; }
  .react { background:var(--bg3); border:1px solid var(--line); border-radius:10px; padding:1px 8px; font-size:12px; cursor:default; }
  .members { background:var(--bg2); border-left:1px solid var(--line); padding:16px 12px; height:100vh; overflow:auto; position:sticky; top:0; }
  .members h3 { margin:4px 4px 12px; font-size:13px; text-transform:uppercase; letter-spacing:.5px; color:var(--muted); }
  .card { background:var(--bg); border:1px solid var(--line); border-radius:10px; overflow:hidden; margin-bottom:12px; }
  .banner { height:56px; background-size:cover; background-position:center; background-color:var(--bg3); }
  .card-body { padding:0 12px 12px; margin-top:-20px; }
  .card-avatar { width:44px; height:44px; border-radius:50%; border:3px solid var(--bg); object-fit:cover; background:var(--bg3); }
  .card-name { font-weight:700; margin-top:4px; }
  .card-handle { color:var(--muted); font-size:12px; }
  .style-tag { text-transform:uppercase; font-size:10px; letter-spacing:.5px; }
  .card-npub { color:var(--muted); font-size:11px; font-family:ui-monospace,monospace; margin:2px 0; }
  .card-bio { font-size:12.5px; margin:6px 0; }
  .card-badges { display:flex; gap:4px; flex-wrap:wrap; }
  .badge { font-size:10px; background:var(--bg3); color:var(--muted); border-radius:6px; padding:1px 6px; }
  .banner-note { padding:6px 8px; margin:0 4px 12px; font-size:11px; color:var(--muted); background:var(--bg3); border-radius:6px; }
</style></head>
<body>
  <div class="layout">
    <nav class="side">
      <h1>${esc(seed.name)}</h1>
      <p class="note">Seed preview · ${seed.messages.length} messages · ${members.length} members · NOT published</p>
      ${nav}
    </nav>
    <main>${channelSections}</main>
    <aside class="members">
      <h3>Members, ${members.length}</h3>
      <p class="banner-note">Real personas: gendered portraits (randomuser). Anon: character avatars (dicebear). Banners: picsum. All keyed per persona.</p>
      ${roster}
    </aside>
  </div>
</body></html>`;
}

function indexHtml(keys: string[]): string {
  const cards = keys
    .map((k) => {
      const s = SEEDS[k]!;
      const members = personasFor(s.key).length;
      return `<a class="tile" href="./${k}.html"><div class="tile-name">${esc(s.name)}</div><div class="tile-meta">${s.messages.length} messages · ${members} members</div></a>`;
    })
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Armada seed preview</title>
<style>
  body { margin:0; background:#16181c; color:#dfe3e8; font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif; padding:40px; }
  h1 { font-size:20px; } p.note { color:#8a919c; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); gap:14px; margin-top:20px; }
  .tile { display:block; background:#1d1f24; border:1px solid #2c2f36; border-radius:12px; padding:18px; text-decoration:none; color:inherit; }
  .tile:hover { background:#24272e; }
  .tile-name { font-weight:700; font-size:16px; }
  .tile-meta { color:#8a919c; font-size:13px; margin-top:4px; }
</style></head><body>
  <h1>Armada seed preview</h1>
  <p class="note">${keys.length} communities · dry-run render · nothing published</p>
  <div class="grid">${cards}</div>
</body></html>`;
}

function main() {
  const arg = process.argv[2] ?? "discord-refugees";
  const keys = arg === "all" ? Object.keys(SEEDS) : SEEDS[arg] ? [arg] : [];
  if (keys.length === 0) {
    console.error(`unknown seed "${arg}". known: ${Object.keys(SEEDS).join(", ")}, or "all"`);
    process.exit(1);
  }

  const master = loadOrCreateMaster();
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = join(here, "out");
  mkdirSync(outDir, { recursive: true });

  for (const key of keys) {
    writeFileSync(join(outDir, `${key}.html`), render(SEEDS[key]!, master));
    console.log(`Wrote ${join(outDir, `${key}.html`)}`);
  }

  if (arg === "all") {
    const indexFile = join(outDir, "index.html");
    writeFileSync(indexFile, indexHtml(keys));
    console.log(`\nIndex:\n  file://${indexFile}`);
  } else {
    console.log(`\nOpen in Chrome:\n  file://${join(outDir, `${keys[0]}.html`)}`);
  }
}

main();
