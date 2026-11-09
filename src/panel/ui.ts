/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { Config } from "../config.js";
import { escapeHtml as esc } from "../util/html.js";

export interface LoginPageOptions {
  canConnect: boolean;
  hasConnection: boolean;
  showSetup?: boolean;
  error?: string;
}

export function renderLoginPage(config: Config, nonce: string, options: LoginPageOptions): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>SoundCloud Studio — Sign in</title>
<style nonce="${nonce}">
  :root { --accent: ${config.brandColor}; color-scheme: dark; }
  *{box-sizing:border-box} body{margin:0;min-height:100vh;display:grid;place-items:center;
  background:radial-gradient(900px 500px at 50% -10%, #211a16, #070707 65%);
  font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#eee;padding:24px}
  .card{width:min(460px,100%);background:#121212;border:1px solid #282828;border-radius:18px;padding:30px;
  box-shadow:0 30px 90px rgba(0,0,0,.6)}
  h1{margin:0 0 8px;font-size:21px} p{margin:0 0 18px;color:#9a9a9a;font-size:13px}
  .btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:46px;
  margin-top:20px;padding:12px 16px;border-radius:11px;border:1px solid rgba(255,255,255,.14);
  background-color:var(--accent);
  background-image:linear-gradient(180deg, rgba(255,255,255,.18) 0%, rgba(0,0,0,.08) 100%);
  color:#fff;font-weight:750;font-size:15px;text-decoration:none;letter-spacing:.01em;
  box-shadow:0 10px 24px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.22);
  transition:transform .12s ease, filter .12s ease, box-shadow .12s ease}
  .btn:hover{filter:brightness(1.08);transform:translateY(-1px);text-decoration:none;
  box-shadow:0 14px 30px rgba(0,0,0,.48), inset 0 1px 0 rgba(255,255,255,.24)}
  .btn:active{transform:translateY(0);filter:brightness(.98)}
  .btn:focus-visible{outline:2px solid #fff;outline-offset:3px}
  .err{background:#3a1111;border:1px solid #6b2020;color:#ffb4b4;padding:10px 12px;border-radius:10px;
  font-size:13px;margin-bottom:14px}
  .hint{margin-top:18px;color:#777;font-size:12px} code{background:#222;padding:2px 6px;border-radius:6px}
  a{color:var(--accent)} .note{border:1px solid #2a2a2a;background:#0c0c0c;border-radius:10px;padding:10px 12px;
  font-size:12px;color:#999;margin-top:16px}
</style></head>
<body><main class="card">
  <h1>SoundCloud Studio</h1>
  <p>Sign in with your SoundCloud account in this browser. The server opens the
     authorization page, receives the callback, and stores the SoundCloud tokens
     encrypted on this device. No token is copied or pasted.</p>
  ${options.error ? `<div class="err">${esc(options.error)}</div>` : ""}
  ${
    options.canConnect
      ? `<a class="btn" href="/panel/auth/start">Sign in with SoundCloud</a>`
      : `<div class="note"><strong>SoundCloud app credentials are not configured.</strong><br />
         ${
           options.showSetup
             ? `<a href="/panel/setup">Set up this device</a> — enter your own SoundCloud app credentials once; they are stored encrypted in DATA_DIR.`
             : `Set <code>SC_CLIENT_ID</code> and <code>SC_CLIENT_SECRET</code> in the server environment and restart.`
         }</div>`
  }
  ${
    options.hasConnection
      ? `<div class="note">An existing SoundCloud connection is stored on this device.
         If it is still valid, open <a href="/panel">the studio</a>; otherwise sign in again.</div>`
      : ""
  }
  <div class="hint">MCP clients can drive the same actions through tools or the REST API.</div>
</main></body></html>`;
}

export function renderSetupPage(config: Config, nonce: string, error?: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>SoundCloud Studio — Device setup</title>
<style nonce="${nonce}">
  :root { --accent: ${config.brandColor}; color-scheme: dark; }
  *{box-sizing:border-box} body{margin:0;min-height:100vh;display:grid;place-items:center;
  background:radial-gradient(900px 500px at 50% -10%, #211a16, #070707 65%);
  font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#eee;padding:24px}
  .card{width:min(500px,100%);background:#121212;border:1px solid #282828;border-radius:18px;padding:30px;
  box-shadow:0 30px 90px rgba(0,0,0,.6)}
  h1{margin:0 0 8px;font-size:21px} p{margin:0 0 18px;color:#9a9a9a;font-size:13px}
  label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#888;margin:14px 0 6px}
  input{width:100%;padding:11px 12px;border-radius:10px;border:1px solid #333;background:#0b0b0b;color:#fff;font-size:14px}
  input:focus{outline:2px solid color-mix(in srgb,var(--accent) 60%,transparent);border-color:transparent}
  button{display:flex;align-items:center;justify-content:center;width:100%;min-height:46px;margin-top:20px;
  padding:12px 16px;border:1px solid rgba(255,255,255,.14);border-radius:10px;
  background-color:var(--accent);
  background-image:linear-gradient(180deg, rgba(255,255,255,.18) 0%, rgba(0,0,0,.08) 100%);
  color:#fff;font-weight:750;font-size:15px;cursor:pointer;letter-spacing:.01em;
  box-shadow:0 10px 24px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.22);
  transition:transform .12s ease, filter .12s ease, box-shadow .12s ease}
  button:hover{filter:brightness(1.08);transform:translateY(-1px);
  box-shadow:0 14px 30px rgba(0,0,0,.48), inset 0 1px 0 rgba(255,255,255,.24)}
  button:active{transform:translateY(0);filter:brightness(.98)}
  button:focus-visible{outline:2px solid #fff;outline-offset:3px}
  .err{background:#3a1111;border:1px solid #6b2020;color:#ffb4b4;padding:10px 12px;border-radius:10px;
  font-size:13px;margin-bottom:14px}
  .note{border:1px solid #2a2a2a;background:#0c0c0c;border-radius:10px;padding:10px 12px;font-size:12px;color:#999;margin-top:14px}
  .steps{display:grid;gap:10px;margin:18px 0}
  .step{display:flex;gap:12px;align-items:flex-start;background:#0d0d0d;border:1px solid #242424;
  border-radius:12px;padding:12px 14px;font-size:13px;color:#bbb;line-height:1.55}
  .step b{flex:0 0 24px;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;
  background:#1b120e;border:1px solid #4a2a1c;color:var(--accent);font-size:12px;line-height:1;margin-top:1px}
  .step a:not(.btn){color:var(--accent);text-decoration:underline;text-underline-offset:2px}
  .step a:not(.btn):hover{color:#fff}
  .btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:44px;
  margin-top:10px;padding:11px 16px;border-radius:10px;border:1px solid rgba(255,255,255,.14);
  background-color:var(--accent);
  background-image:linear-gradient(180deg, rgba(255,255,255,.18) 0%, rgba(0,0,0,.08) 100%);
  color:#fff;font-weight:750;font-size:13.5px;text-decoration:none;letter-spacing:.01em;
  box-shadow:0 8px 20px rgba(0,0,0,.38), inset 0 1px 0 rgba(255,255,255,.22);
  transition:transform .12s ease, filter .12s ease, box-shadow .12s ease}
  .btn:hover{filter:brightness(1.08);transform:translateY(-1px);text-decoration:none;
  box-shadow:0 12px 26px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.24)}
  .btn:active{transform:translateY(0);filter:brightness(.98)}
  .btn:focus-visible{outline:2px solid #fff;outline-offset:3px}
  code{background:#222;padding:2px 6px;border-radius:6px} a{color:var(--accent)}
  .hint{margin-top:16px;color:#777;font-size:12px}
</style></head>
<body><main class="card">
  <h1>Device setup</h1>
  <p>Create a SoundCloud app once, then paste its client ID and secret here.
     These are <strong>app credentials</strong>, not your SoundCloud login/password.
     They are encrypted with AES-256-GCM in DATA_DIR and are never written to the repo.
     The next screen is SoundCloud's own login/authorization page.</p>
  ${error ? `<div class="err">${esc(error)}</div>` : ""}
  <div class="steps">
    <div class="step"><b>1</b><div>Open SoundCloud. If you are not signed in, SoundCloud asks for
      your login/password on its own page and then returns you to the Apps page.
      <a class="btn" href="https://soundcloud.com/you/apps" target="_blank" rel="noreferrer">Open SoundCloud → Apps</a></div></div>
    <div class="step"><b>2</b><div>On the Apps page open your app (or create one) and copy its
      <strong>Client ID</strong> and <strong>Client Secret</strong>.</div></div>
    <div class="step"><b>3</b><div>Paste them below and press the button. The server stores them
      encrypted and immediately redirects to SoundCloud's official authorization page.</div></div>
  </div>
  <form method="post" action="/panel/setup">
    <label for="client_id">SoundCloud client ID</label>
    <input id="client_id" name="client_id" type="text" autocomplete="off" required />
    <label for="client_secret">SoundCloud client secret</label>
    <input id="client_secret" name="client_secret" type="password" autocomplete="off" required />
    <button type="submit">Save and continue to SoundCloud</button>
  </form>
  <div class="note">Register this exact redirect URI in your app:
    <br /><code>${esc(config.sc.redirectUri)}</code><br />
    App management: <a href="https://soundcloud.com/you/apps" target="_blank" rel="noreferrer">soundcloud.com/you/apps</a>
    <br /><br />SoundCloud currently restricts API app registration to <strong>Artist Pro</strong>
    accounts (official response, 2026-11-02). If registration says
    “Application registration is not available for your account”, upgrade the
    account or use an existing app's credentials.</div>
  <div class="hint">Setup is available only from this device (loopback request).</div>
</main></body></html>`;
}

export function renderPanel(config: Config, nonce: string): string {
  const bootstrap = JSON.stringify({
    mode: config.mode,
    version: config.version,
    maxUploadBytes: config.sc.maxUploadBytes,
    autoLogin: config.security.panelAutoLogin,
  }).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>SoundCloud Studio</title>
<style nonce="${nonce}">
  :root{--accent:${config.brandColor};--bg:#070707;--card:#121212;--line:#262626;--muted:#8f8f8f;color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:#ededed;font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  a{color:var(--accent);text-decoration:none} a:hover{text-decoration:underline}
  button{font:inherit;cursor:pointer;border-radius:9px;border:1px solid var(--line);background:#1b1b1b;color:#eee;padding:8px 12px;
    transition:background .12s ease,border-color .12s ease,transform .1s ease}
  button:hover{border-color:#3a3a3a;background:#222}
  button:active{transform:translateY(1px)}
  button:focus-visible{outline:2px solid color-mix(in srgb,var(--accent) 70%,transparent);outline-offset:2px}
  button.primary{background:var(--accent);border-color:transparent;color:#fff;font-weight:700}
  button.danger{background:#2a1010;border-color:#5a1d1d;color:#ffb4b4}
  input,select,textarea{font:inherit;width:100%;padding:9px 11px;border-radius:9px;border:1px solid var(--line);
    background:#0b0b0b;color:#eee}
  input:focus,select:focus,textarea:focus{outline:2px solid color-mix(in srgb,var(--accent) 55%,transparent);border-color:transparent}
  header{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:14px;padding:14px 22px;
    background:rgba(7,7,7,.86);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
  .brand{font-weight:800;letter-spacing:.02em;display:flex;align-items:center;gap:9px}
  .dot{width:10px;height:10px;border-radius:50%;background:var(--accent);box-shadow:0 0 18px var(--accent)}
  .spacer{flex:1}
  .avatar{width:34px;height:34px;border-radius:50%;object-fit:cover;background:#222}
  .pill{font-size:11px;color:var(--muted);border:1px solid var(--line);padding:3px 8px;border-radius:999px}
  .banner{margin:0;padding:10px 22px;background:#2a1410;border-bottom:1px solid #4a241c;color:#ffc9b8;
    font-size:13px;display:flex;gap:12px;align-items:center;justify-content:center}
  .banner a{font-weight:700}
  .banner[hidden]{display:none}
  main{max-width:1180px;margin:0 auto;padding:22px}
  .tabs{display:flex;gap:6px;flex-wrap:wrap;margin:4px 0 20px}
  .tabs button{border:0;background:transparent;color:var(--muted);padding:8px 12px;border-radius:8px;font-weight:600}
  .tabs button.active{background:#1c1c1c;color:#fff}
  .grid{display:grid;gap:14px}
  .cols{grid-template-columns:repeat(auto-fit,minmax(230px,1fr))}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px}
  .card h3{margin:0 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)}
  .stat{font-size:26px;font-weight:800;letter-spacing:-.02em}
  .row{display:flex;align-items:center;gap:10px}
  .between{justify-content:space-between}
  .muted{color:var(--muted)} .small{font-size:12px} .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .section{display:none} .section.active{display:block}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;color:var(--muted);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.06em;
    padding:8px 10px;border-bottom:1px solid var(--line)}
  td{padding:9px 10px;border-bottom:1px solid #1a1a1a;vertical-align:middle}
  tr:hover td{background:#161616}
  .cover{width:38px;height:38px;border-radius:7px;object-fit:cover;background:#222}
  .actions{display:flex;gap:6px;flex-wrap:wrap}
  .actions button{padding:5px 8px;font-size:12px}
  .bar{height:7px;border-radius:999px;background:#222;overflow:hidden}
  .bar > i{display:block;height:100%;background:var(--accent);width:0;transition:width .25s}
  .queue{margin-top:14px;display:grid;gap:9px}
  .qitem{background:#0d0d0d;border:1px solid var(--line);border-radius:10px;padding:10px 12px}
  .toast{position:fixed;right:18px;bottom:18px;display:grid;gap:8px;z-index:50}
  .toast div{background:#161616;border:1px solid #2e2e2e;border-left:3px solid var(--accent);padding:10px 14px;
    border-radius:9px;max-width:360px;box-shadow:0 12px 40px rgba(0,0,0,.5);font-size:13px}
  .toast .bad{border-left-color:#e05252}
  .modal{position:fixed;inset:0;background:rgba(0,0,0,.72);display:none;place-items:center;padding:20px;z-index:40}
  .modal.open{display:grid}
  .modal .card{width:min(560px,100%);max-height:88vh;overflow:auto}
  .field{margin-bottom:10px} .field label{display:block;font-size:11px;color:var(--muted);margin-bottom:4px;
    text-transform:uppercase;letter-spacing:.06em}
  .drop{border:1px dashed #3a3a3a;border-radius:12px;padding:26px;text-align:center;color:var(--muted);
    background:#0b0b0b;cursor:pointer}
  .drop.hover{border-color:var(--accent);color:#ddd}
  .seg{display:flex;gap:6px;flex-wrap:wrap}
  .seg button{border-radius:999px;font-size:12px;padding:5px 10px}
  .seg button.on{background:var(--accent);border-color:transparent;color:#fff;font-weight:700}
  .empty{padding:26px;text-align:center;color:var(--muted)}
  @media(max-width:640px){main{padding:14px}header{padding:12px}td.hide-sm,th.hide-sm{display:none}}
</style></head>
<body>
<header>
  <div class="brand"><span class="dot"></span>SoundCloud Studio</div>
  <span class="pill" id="mode-pill">${esc(config.mode)}</span>
  <div class="spacer"></div>
  <img class="avatar" id="me-avatar" alt="" />
  <span id="me-name" class="muted small">loading…</span>
  <a class="small" href="/panel/logout" onclick="return fetch('/panel/logout',{method:'POST',headers:{'x-scmcp-csrf':'1'}}).then(function(){location.href='/panel/login'})">sign out</a>
</header>
<div class="banner" id="banner" hidden><span id="banner-text"></span><a href="/panel/auth/start">Reconnect SoundCloud</a></div>
<main>
  <div class="tabs" id="tabs">
    <button data-tab="overview" class="active">Overview</button>
    <button data-tab="upload">Upload</button>
    <button data-tab="audio">Audio lab</button>
    <button data-tab="tracks">Tracks</button>
    <button data-tab="playlists">Playlists</button>
    <button data-tab="social">Social</button>
    <button data-tab="settings">Settings</button>
  </div>

  <section class="section active" id="sec-overview">
    <div class="grid cols">
      <div class="card"><h3>Profile</h3><div class="row"><img class="avatar" id="ov-avatar" alt="" />
        <div><div style="font-weight:700" id="ov-name">—</div><div class="small muted" id="ov-link">—</div></div></div>
        <div class="small muted" style="margin-top:10px" id="ov-plan"></div></div>
      <div class="card"><h3>Upload quota</h3><div class="stat" id="ov-quota">—</div>
        <div class="bar" style="margin:8px 0"><i id="ov-quota-bar"></i></div>
        <div class="small muted" id="ov-quota-note"></div></div>
      <div class="card"><h3>Tracks</h3><div class="stat" id="ov-tracks">—</div><div class="small muted">public</div></div>
      <div class="card"><h3>Followers</h3><div class="stat" id="ov-followers">—</div><div class="small muted">listeners</div></div>
      <div class="card"><h3>Playlists</h3><div class="stat" id="ov-playlists">—</div><div class="small muted">sets</div></div>
    </div>
    <div class="card" style="margin-top:14px"><div class="row between"><h3 style="margin:0">Recent tracks</h3>
      <button id="refresh-recent">Refresh</button></div><div id="recent-tracks" class="empty">loading…</div></div>
  </section>

  <section class="section" id="sec-upload">
    <div class="card">
      <h3>Upload tracks</h3>
      <div class="drop" id="drop">Drop MP3/WAV/FLAC files here or click to choose<br />
        <span class="small">ID3 tags and embedded artwork are read automatically. Files are streamed, never buffered in RAM.</span>
        <input id="file-input" type="file" multiple accept="audio/*" style="display:none" /></div>
      <div class="grid cols" style="margin-top:14px">
        <div class="field"><label>Sharing</label><select id="up-sharing"><option value="private">private</option><option value="public">public</option></select></div>
        <div class="field"><label>Genre</label><input id="up-genre" placeholder="Hip-Hop/Rap" /></div>
        <div class="field"><label>Tags</label><input id="up-tags" placeholder="rap, mixtape, 2026" /></div>
        <div class="field"><label>Artist override</label><input id="up-artist" placeholder="from ID3 when empty" /></div>
      </div>
      <div class="small muted">SoundCloud limits: 4 GB / 24 h per track. Track appears after asynchronous transcoding.</div>
      <div class="queue" id="queue"></div>
    </div>
  </section>

  <section class="section" id="sec-audio">
    <div class="card">
      <h3>Audio lab — local MP3 editor</h3>
      <div class="row"><input id="al-path" placeholder="Absolute path inside SC_MEDIA_DIRS (e.g. ~/Music/track.mp3)" />
        <button id="al-probe" class="primary">Read</button></div>
      <div class="row" style="margin-top:8px;flex-wrap:wrap">
        <input id="al-stage-file" type="file" accept="audio/*" style="max-width:280px" />
        <button id="al-stage">Stage file</button>
        <span class="small muted">or type a server path above</span>
      </div>
      <div class="small muted" style="margin-top:6px">ID3 tags, artwork, tempo/pitch, loudness, trim and format conversion run locally with ffmpeg.
        Nothing is uploaded until you press Upload.</div>
      <div id="al-info" class="small" style="margin-top:10px"></div>

      <div class="grid cols" style="margin-top:12px">
        <div class="field"><label>Title</label><input id="al-title" /></div>
        <div class="field"><label>Artist</label><input id="al-artist" /></div>
        <div class="field"><label>Album</label><input id="al-album" /></div>
        <div class="field"><label>Album artist</label><input id="al-album_artist" /></div>
        <div class="field"><label>Genre</label><input id="al-genre" /></div>
        <div class="field"><label>Year</label><input id="al-year" /></div>
        <div class="field"><label>Track</label><input id="al-track" /></div>
        <div class="field"><label>Disc</label><input id="al-disc" /></div>
        <div class="field"><label>BPM</label><input id="al-bpm" /></div>
        <div class="field"><label>ISRC</label><input id="al-isrc" /></div>
      </div>
      <div class="field"><label>Comment</label><textarea id="al-comment" rows="2"></textarea></div>
      <div class="field"><label>Lyrics</label><textarea id="al-lyrics" rows="2"></textarea></div>
      <div class="row" style="margin-top:10px;flex-wrap:wrap">
        <input id="al-artwork" type="file" accept="image/*" style="max-width:240px" />
        <button id="al-save-tags" class="primary">Save tags</button>
        <button id="al-save-art">Save artwork</button>
        <button id="al-remove-art" class="danger">Remove artwork</button>
      </div>

      <hr style="border:0;border-top:1px solid var(--line);margin:18px 0" />
      <div class="grid cols">
        <div class="field"><label>Speed / tempo</label>
          <div class="row"><input id="al-ratio" type="number" min="0.25" max="4" step="0.01" value="1.25" />
            <select id="al-mode"><option value="tempo">tempo (keep pitch)</option><option value="pitch">pitch</option><option value="speed">tape speed</option><option value="both">tempo + pitch</option></select></div></div>
        <div class="field"><label>Algorithm</label><select id="al-algorithm"><option value="auto">auto (rubberband)</option><option value="rubberband">rubberband</option><option value="atempo">atempo</option></select></div>
        <div class="field"><label>Normalize LUFS / true peak</label>
          <div class="row"><input id="al-lufs" type="number" value="-14" step="0.5" /><input id="al-tp" type="number" value="-1" step="0.5" /></div></div>
        <div class="field"><label>Trim start / end (seconds)</label>
          <div class="row"><input id="al-start" type="number" value="0" step="0.1" /><input id="al-end" type="number" placeholder="end" step="0.1" /></div></div>
        <div class="field"><label>Convert</label>
          <div class="row"><select id="al-format"><option value="mp3">mp3</option><option value="wav">wav</option><option value="flac">flac</option></select>
            <input id="al-bitrate" type="number" value="320" min="64" max="320" /></div></div>
        <div class="field"><label>Output path (optional)</label><input id="al-output" placeholder="empty = auto suffix" /></div>
      </div>
      <div class="actions" style="margin-top:10px">
        <button id="al-apply-speed">Apply speed</button>
        <button id="al-normalize">Normalize</button>
        <button id="al-trim">Trim</button>
        <button id="al-convert">Convert</button>
      </div>
      <div id="al-result" class="small" style="margin-top:12px"></div>

      <hr style="border:0;border-top:1px solid var(--line);margin:18px 0" />
      <h3>Upload edited file</h3>
      <div class="grid cols">
        <div class="field"><label>Title</label><input id="al-up-title" /></div>
        <div class="field"><label>Artist</label><input id="al-up-artist" /></div>
        <div class="field"><label>Genre</label><input id="al-up-genre" /></div>
        <div class="field"><label>Tags</label><input id="al-up-tags" /></div>
        <div class="field"><label>Sharing</label><select id="al-up-sharing"><option value="private">private</option><option value="public">public</option></select></div>
      </div>
      <button id="al-upload" class="primary" style="margin-top:10px">Upload to SoundCloud</button>
    </div>
  </section>

  <section class="section" id="sec-tracks">
    <div class="card"><div class="row between"><h3 style="margin:0">My tracks</h3>
      <div class="actions"><button id="tracks-refresh">Refresh</button><button id="tracks-more">Load more</button></div></div>
      <div id="tracks-table"></div></div>
  </section>

  <section class="section" id="sec-playlists">
    <div class="card"><div class="row between"><h3 style="margin:0">Playlists</h3>
      <button class="primary" id="playlist-new">New playlist</button></div>
      <div id="playlists-list" class="empty">loading…</div></div>
  </section>

  <section class="section" id="sec-social">
    <div class="grid cols">
      <div class="card"><h3>Followers</h3><div id="social-followers" class="empty">loading…</div></div>
      <div class="card"><h3>Following</h3><div id="social-followings" class="empty">loading…</div></div>
    </div>
    <div class="card" style="margin-top:14px"><h3>Liked tracks</h3><div id="social-likes" class="empty">loading…</div></div>
  </section>

  <section class="section" id="sec-settings">
    <div class="card"><h3>Profile</h3>
      <div class="grid cols">
        <div class="field"><label>Username</label><input id="pf-username" /></div>
        <div class="field"><label>Full name</label><input id="pf-full_name" /></div>
        <div class="field"><label>City</label><input id="pf-city" /></div>
        <div class="field"><label>Country</label><input id="pf-country" /></div>
        <div class="field"><label>Website</label><input id="pf-website" /></div>
        <div class="field"><label>Website title</label><input id="pf-website_title" /></div>
      </div>
      <div class="field"><label>Description</label><textarea id="pf-description" rows="3"></textarea></div>
      <div class="row"><button class="primary" id="save-profile">Save profile</button>
        <input id="avatar-input" type="file" accept="image/*" style="display:none" />
        <button id="avatar-btn">Upload avatar</button></div>
    </div>
    <div class="card" style="margin-top:14px"><h3>Endpoints</h3>
      <div class="small mono" id="settings-endpoints">—</div>
      <div class="small muted" style="margin-top:8px">Control everything from opencode2 via MCP tools or these REST endpoints.
        Mutations require the <span class="mono">x-scmcp-csrf</span> header when using cookie auth.</div>
    </div>
  </section>
</main>

<div class="toast" id="toast"></div>
<div class="modal" id="modal"><div class="card" id="modal-body"></div></div>
<script type="application/json" id="bootstrap">${bootstrap}</script>
<script nonce="${nonce}">
(function(){
  var CFG = JSON.parse(document.getElementById('bootstrap').textContent);
  var state = { me:null, tracks:[], trackNext:null, playlists:[], likes:[], followers:[], followings:[], quota:null };

  function $(id){ return document.getElementById(id); }
  function esc(v){ return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
  function toast(msg,bad){ var box=$('toast'); var d=document.createElement('div'); if(bad)d.className='bad';
    d.textContent=String(msg); box.appendChild(d); setTimeout(function(){ d.remove(); }, bad?7000:3500); }
  function api(path, opts){
    opts = opts || {};
    opts.credentials = 'same-origin';
    opts.headers = Object.assign({'x-scmcp-csrf':'1'}, opts.headers||{});
    if(opts.body && !(opts.body instanceof FormData)){ opts.headers['content-type']='application/json'; opts.body=JSON.stringify(opts.body); }
    return fetch(path, opts).then(function(r){
      return r.text().then(function(t){
        var j = null; try { j = t ? JSON.parse(t) : null; } catch(e) { j = {raw:t}; }
        if(!r.ok){ var err = new Error((j && (j.message || j.error_description || (j.error && j.error.message))) || ('HTTP '+r.status)); err.payload=j; throw err; }
        return j;
      });
    });
  }
  function fmtNum(n){ if(n==null) return '—'; return Number(n).toLocaleString(); }
  function fmtDur(ms){ if(!ms) return '—'; var s=Math.floor(ms/1000); var m=Math.floor(s/60); s=s%60; return m+':'+(s<10?'0':'')+s; }
  function initials(name){ return (name||'?').slice(0,2).toUpperCase(); }
  function avatar(url,name){ return url || ('data:image/svg+xml;charset=utf-8,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#222"/><text x="40" y="48" font-size="26" fill="#888" text-anchor="middle" font-family="sans-serif">'+esc(initials(name))+'</text></svg>')); }
  function urnOf(x){ if(!x) return ''; if(typeof x==='string') return x; if(x.urn) return x.urn; return 'soundcloud:tracks:'+x.id; }

  function tab(name){
    Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function(b){ b.classList.toggle('active', b.getAttribute('data-tab')===name); });
    Array.prototype.forEach.call(document.querySelectorAll('.section'), function(s){ s.classList.toggle('active', s.id==='sec-'+name); });
    if(name==='upload') renderQueue();
  }
  $('tabs').addEventListener('click', function(e){ var b=e.target.closest('button'); if(b) tab(b.getAttribute('data-tab')); });

  function loadState(){
    return api('/api/state').then(function(s){
      $('banner').hidden = true;
      state.me = s.me; state.quota = s.quota; state.tracks = (s.tracks && s.tracks.items) || [];
      state.trackNext = s.tracks && s.tracks.next; state.playlists = (s.playlists && s.playlists.items) || [];
      state.likes = (s.likes && s.likes.items) || []; state.followers = (s.followers && s.followers.items) || [];
      state.followings = (s.followings && s.followings.items) || [];
      paintMe(); paintOverview(); paintTracks(); paintPlaylists(); paintSocial(); paintSettings();
    }).catch(function(e){
      var code = e.payload && e.payload.code;
      if(code === 'NEEDS_REAUTH' || code === 'TOKEN_EXPIRED' || code === 'UNAUTHORIZED'){
        $('banner-text').textContent = 'SoundCloud authorization expired. Reconnect to keep uploading and editing.';
        $('banner').hidden = false;
      }
      toast('Failed to load state: '+e.message, true);
    });
  }

  function paintMe(){
    var me=state.me||{}; $('me-name').textContent = me.username || 'not connected';
    $('me-avatar').src = avatar(me.avatar_url, me.username); $('me-avatar').onerror=function(){ this.src=avatar(null,'?'); };
    $('mode-pill').textContent = CFG.mode + ' · v' + CFG.version;
  }
  function paintOverview(){
    var me=state.me||{}; $('ov-avatar').src=avatar(me.avatar_url,me.username);
    $('ov-name').textContent=me.username||'—';
    $('ov-link').innerHTML = me.permalink_url ? '<a href="'+esc(me.permalink_url)+'" target="_blank" rel="noreferrer">'+esc(me.permalink_url)+'</a>' : '—';
    $('ov-plan').textContent = me.plan ? ('plan: '+me.plan) : '';
    $('ov-tracks').textContent=fmtNum(me.track_count); $('ov-followers').textContent=fmtNum(me.followers_count);
    $('ov-playlists').textContent=fmtNum(me.playlist_count);
    var q=state.quota||{}; var left=q.secondsLeft;
    $('ov-quota').textContent = q.unlimited ? 'Unlimited' : (left==null?'—':Math.round(left/3600)+' h');
    var used = q.secondsUsed||0; var total = (left==null? (used||1) : used+left);
    var pct = q.unlimited?100:Math.max(0,Math.min(100,Math.round(used/Math.max(1,total)*100)));
    $('ov-quota-bar').style.width=pct+'%';
    $('ov-quota-note').textContent = q.unlimited ? 'unlimited upload quota' : ('used '+(used/3600).toFixed(1)+' h of '+(total/3600).toFixed(1)+' h');
    renderRecent();
  }
  function renderRecent(){
    var box=$('recent-tracks'); var rows=(state.tracks||[]).slice(0,6);
    if(!rows.length){ box.className='empty'; box.textContent='No tracks yet.'; return; }
    box.className=''; box.innerHTML=tableHtml(rows,false);
  }
  function tableHtml(rows, withActions){
    var html='<table><thead><tr><th></th><th>Title</th><th class="hide-sm">Genre</th><th class="hide-sm">Duration</th><th class="hide-sm">Plays</th><th></th></tr></thead><tbody>';
    rows.forEach(function(t){
      var u=urnOf(t);
      html+='<tr><td><img class="cover" src="'+esc(t.artwork_url||'')+'" onerror="this.style.visibility=\\'hidden\\'" /></td>'+
        '<td><div style="font-weight:600">'+esc(t.title)+'</div><div class="small muted">'+esc(t.sharing||'')+'</div></td>'+
        '<td class="hide-sm">'+esc(t.genre||'—')+'</td><td class="hide-sm">'+fmtDur(t.duration)+'</td>'+
        '<td class="hide-sm">'+fmtNum(t.playback_count)+'</td><td><div class="actions">'+
        (withActions? '<button data-act="like" data-urn="'+esc(u)+'">Like</button><button data-act="repost" data-urn="'+esc(u)+'">Repost</button><button data-act="edit" data-urn="'+esc(u)+'">Edit</button><button class="danger" data-act="delete" data-urn="'+esc(u)+'">Delete</button>':'')+
        (t.permalink_url? '<a href="'+esc(t.permalink_url)+'" target="_blank" rel="noreferrer"><button>Open</button></a>':'')+
        '</div></td></tr>';
    });
    return html+'</tbody></table>';
  }
  function paintTracks(){ var box=$('tracks-table'); if(!state.tracks.length){ box.className='empty'; box.textContent='No tracks.'; return; }
    box.className=''; box.innerHTML=tableHtml(state.tracks,true); }
  function findTrack(urn){ return state.tracks.filter(function(t){ return urnOf(t)===urn; })[0]; }

  $('tracks-table').addEventListener('click', function(e){
    var b=e.target.closest('button[data-act]'); if(!b) return; var act=b.getAttribute('data-act'); var urn=b.getAttribute('data-urn');
    if(act==='like') api('/api/social/like',{method:'POST',body:{kind:'track',urn:urn,action:'like'}}).then(function(){toast('Liked');}).catch(function(err){toast(err.message,true);});
    if(act==='repost') api('/api/social/repost',{method:'POST',body:{urn:urn,action:'repost'}}).then(function(){toast('Reposted');}).catch(function(err){toast(err.message,true);});
    if(act==='edit') openTrackEditor(urn);
    if(act==='delete'){ if(!confirm('Delete this track permanently?')) return;
      api('/api/tracks/'+encodeURIComponent(urn),{method:'DELETE'}).then(function(){ toast('Deleted'); loadState(); }).catch(function(err){toast(err.message,true);}); }
  });
  $('tracks-refresh').onclick=function(){ loadState(); };
  $('tracks-more').onclick=function(){ if(!state.trackNext){ toast('No more pages'); return; }
    api('/api/tracks?cursor='+encodeURIComponent(state.trackNext)).then(function(p){ state.tracks=state.tracks.concat(p.items||[]); state.trackNext=p.next; paintTracks(); }); };
  $('refresh-recent').onclick=function(){ loadState(); };

  function triSelect(id, label, current){
    var v = current===true?'true':(current===false?'false':'');
    return '<div class="field"><label>'+esc(label)+'</label><select id="'+id+'"><option value="">unchanged</option>'+
      '<option value="true"'+(v==='true'?' selected':'')+'>yes</option><option value="false"'+(v==='false'?' selected':'')+'>no</option></select></div>';
  }
  function openTrackEditor(urn){
    var t=findTrack(urn)||{};
    var licenses=['all-rights-reserved','cc-by','cc-by-nc','cc-by-nd','cc-by-sa','cc-by-nc-nd','cc-by-nc-sa','no-rights-reserved'];
    var body='<h3>Edit track</h3>'+
      '<div class="grid cols">'+field('Title','te-title',t.title)+field('Artist (metadata_artist)','te-metadata_artist',t.metadata_artist)+
      field('Genre','te-genre',t.genre)+field('Tags','te-tags',t.tag_list)+
      field('Label','te-label_name',t.label_name)+field('Release date','te-release_date',t.release_date)+
      field('ISRC','te-isrc',t.isrc)+field('Permalink','te-permalink',t.permalink)+
      field('Purchase URL','te-purchase_url',t.purchase_url)+field('Purchase title','te-purchase_title',t.purchase_title)+'</div>'+
      '<div class="field"><label>Description</label><textarea id="te-description" rows="3">'+esc(t.description||'')+'</textarea></div>'+
      '<div class="grid cols">'+
      '<div class="field"><label>Sharing</label><select id="te-sharing"><option value="private">private</option><option value="public"'+(t.sharing==='public'?' selected':'')+'>public</option></select></div>'+
      '<div class="field"><label>License</label><select id="te-license"><option value="">unchanged</option>'+licenses.map(function(l){return '<option value="'+l+'"'+(t.license===l?' selected':'')+'>'+l+'</option>';}).join('')+'</select></div>'+
      '<div class="field"><label>Embeddable by</label><select id="te-embeddable_by"><option value="">unchanged</option><option value="all">all</option><option value="me">me</option><option value="none">none</option></select></div>'+
      '<div class="field"><label>Streamable</label><select id="te-streamable"><option value="">unchanged</option><option value="true">yes</option><option value="false">no</option></select></div>'+
      triSelect('te-downloadable','Downloadable',t.downloadable)+
      triSelect('te-commentable','Commentable',t.commentable)+
      triSelect('te-reveal_stats','Reveal stats',t.reveal_stats)+
      triSelect('te-reveal_comments','Reveal comments',t.reveal_comments)+
      '</div>'+
      '<div class="field"><label>Artwork</label><div class="row"><input id="te-artwork" type="file" accept="image/*" /><button id="te-artwork-btn">Upload artwork</button></div></div>'+
      '<div class="actions"><button class="primary" id="te-save">Save metadata</button>'+
      (t.permalink_url?'<a href="'+esc(t.permalink_url)+'" target="_blank" rel="noreferrer"><button>Open</button></a>':'')+
      '<button id="te-cancel">Cancel</button></div>';
    openModal(body);
    $('te-cancel').onclick=closeModal;
    $('te-save').onclick=function(){
      var payload={};
      ['title','description','genre','metadata_artist','label_name','release_date','isrc','permalink','purchase_url','purchase_title','license','embeddable_by','sharing'].forEach(function(k){
        var el=$('te-'+k); if(el && el.value.trim()) payload[k]=el.value.trim();
      });
      var tags=$('te-tags').value.trim(); if(tags) payload.tags=tags;
      ['downloadable','streamable','commentable','reveal_stats','reveal_comments'].forEach(function(k){
        var v=$('te-'+k).value; if(v) payload[k]=v==='true';
      });
      if(!Object.keys(payload).length){ toast('Nothing to save'); return; }
      api('/api/tracks/'+encodeURIComponent(urn),{method:'PATCH',body:payload})
        .then(function(){ closeModal(); toast('Saved'); loadState(); }).catch(function(err){toast(err.message,true);});
    };
    $('te-artwork-btn').onclick=function(){
      var f=$('te-artwork').files[0]; if(!f){ toast('Choose an image'); return; }
      var fd=new FormData(); fd.append('file',f);
      api('/api/tracks/'+encodeURIComponent(urn)+'/artwork',{method:'PUT',body:fd})
        .then(function(){ toast('Artwork uploaded'); loadState(); }).catch(function(err){toast(err.message,true);});
    };
  }

  function paintPlaylists(){
    var box=$('playlists-list');
    if(!state.playlists.length){ box.className='empty'; box.textContent='No playlists yet.'; return; }
    box.className=''; var html='<div class="grid">';
    state.playlists.forEach(function(p){
      var u=urnOf(p);
      html+='<div class="card"><div class="row between"><div><div style="font-weight:700">'+esc(p.title)+'</div>'+
        '<div class="small muted">'+fmtNum(p.track_count)+' tracks · '+esc(p.sharing||'')+'</div></div><div class="actions">'+
        (p.permalink_url?'<a href="'+esc(p.permalink_url)+'" target="_blank" rel="noreferrer"><button>Open</button></a>':'')+
        '<button data-pl="edit" data-urn="'+esc(u)+'">Manage</button><button class="danger" data-pl="delete" data-urn="'+esc(u)+'">Delete</button></div></div></div>';
    });
    box.innerHTML=html+'</div>';
  }
  $('playlists-list').addEventListener('click', function(e){
    var b=e.target.closest('button[data-pl]'); if(!b) return; var u=b.getAttribute('data-urn');
    if(b.getAttribute('data-pl')==='delete'){ if(!confirm('Delete playlist?')) return;
      api('/api/playlists/'+encodeURIComponent(u),{method:'DELETE'}).then(function(){toast('Deleted');loadState();}).catch(function(err){toast(err.message,true);}); }
    if(b.getAttribute('data-pl')==='edit') openPlaylistEditor(u);
  });
  $('playlist-new').onclick=function(){
    openModal('<h3>New playlist / album</h3>'+field('Title','np-title','')+field('Description','np-description','')+
      '<div class="grid cols"><div class="field"><label>Sharing</label><select id="np-sharing"><option value="private">private</option><option value="public">public</option></select></div>'+
      '<div class="field"><label>Type</label><select id="np-set_type"><option value="playlist">playlist</option><option value="album">album</option></select></div></div>'+
      '<div class="actions"><button class="primary" id="np-save">Create</button><button id="np-cancel">Cancel</button></div>');
    $('np-cancel').onclick=closeModal;
    $('np-save').onclick=function(){ api('/api/playlists',{method:'POST',body:{title:$('np-title').value,description:$('np-description').value,sharing:$('np-sharing').value,set_type:$('np-set_type').value}})
      .then(function(){closeModal();toast('Created');loadState();}).catch(function(err){toast(err.message,true);}); };
  };

  function openPlaylistEditor(urn){
    api('/api/playlists/'+encodeURIComponent(urn)).then(function(p){
      var rows=(p.tracks||[]).map(function(t,idx){ var tu=urnOf(t);
        return '<div class="row between" style="padding:7px 0;border-bottom:1px solid #1a1a1a"><div class="small">'+esc(t.title||tu)+'</div>'+
          '<div class="actions"><button data-move="up" data-idx="'+idx+'" data-urn="'+esc(tu)+'">↑</button>'+
          '<button data-move="down" data-idx="'+idx+'" data-urn="'+esc(tu)+'">↓</button>'+
          '<button class="danger" data-remove="'+esc(tu)+'">×</button></div></div>'; }).join('');
      openModal('<h3>Edit album / playlist</h3>'+
        '<div class="grid cols">'+field('Title','pe-title',p.title)+field('Genre','pe-genre',p.genre)+
        field('Tags','pe-tags',p.tag_list)+field('Label','pe-label_name',p.label_name)+
        field('Release date','pe-release_date',p.release_date)+field('Permalink','pe-permalink',p.permalink)+
        field('Purchase URL','pe-purchase_url',p.purchase_url)+field('Purchase title','pe-purchase_title',p.purchase_title)+
        field('EAN','pe-ean',p.ean)+field('License','pe-license',p.license)+'</div>'+
        '<div class="field"><label>Description</label><textarea id="pe-description" rows="3">'+esc(p.description||'')+'</textarea></div>'+
        '<div class="grid cols">'+
        '<div class="field"><label>Sharing</label><select id="pe-sharing"><option value="private">private</option><option value="public"'+(p.sharing==='public'?' selected':'')+'>public</option></select></div>'+
        '<div class="field"><label>Type</label><select id="pe-set_type"><option value="">unchanged</option><option value="playlist"'+(p.set_type==='playlist'?' selected':'')+'>playlist</option><option value="album"'+(p.set_type==='album'?' selected':'')+'>album</option></select></div>'+
        '</div>'+
        '<div class="field"><label>Artwork</label><div class="row"><input id="pe-artwork" type="file" accept="image/*" /><button id="pe-artwork-btn">Upload artwork</button></div>'+
        '<div class="small muted">SoundCloud documents playlist artwork only on creation; an existing playlist may reject the update (the real error is shown).</div></div>'+
        '<div class="actions"><button class="primary" id="pe-save">Save metadata</button><button id="pe-close">Close</button></div>'+
        '<hr style="border:0;border-top:1px solid var(--line);margin:16px 0" />'+
        '<div class="small muted">'+fmtNum(p.track_count)+' tracks</div>'+
        '<div style="margin:12px 0" id="pl-tracks">'+(rows||'<div class="empty">empty</div>')+'</div>'+
        '<div class="field"><label>Add track (id or URN)</label><div class="row"><input id="pl-add" placeholder="soundcloud:tracks:123"/><button id="pl-add-btn">Add</button></div></div>');
      $('pe-close').onclick=closeModal;
      $('pe-save').onclick=function(){
        var payload={};
        ['title','description','genre','label_name','release_date','permalink','purchase_url','purchase_title','ean','license','sharing','set_type'].forEach(function(k){
          var el=$('pe-'+k); if(el && el.value.trim()) payload[k]=el.value.trim();
        });
        var tags=$('pe-tags').value.trim(); if(tags) payload.tags=tags;
        if(!Object.keys(payload).length){ toast('Nothing to save'); return; }
        api('/api/playlists/'+encodeURIComponent(urn),{method:'PATCH',body:payload})
          .then(function(){ toast('Saved'); loadState(); }).catch(function(err){toast(err.message,true);});
      };
      $('pe-artwork-btn').onclick=function(){
        var f=$('pe-artwork').files[0]; if(!f){ toast('Choose an image'); return; }
        var fd=new FormData(); fd.append('file',f);
        api('/api/playlists/'+encodeURIComponent(urn)+'/artwork',{method:'POST',body:fd})
          .then(function(){ toast('Artwork uploaded'); loadState(); })
          .catch(function(err){ toast(err.message,true); });
      };
      $('pl-add-btn').onclick=function(){ var v=$('pl-add').value.trim(); if(!v) return;
        api('/api/playlists/'+encodeURIComponent(urn)+'/tracks',{method:'POST',body:{add:[v]}}).then(function(){closeModal();toast('Added');openPlaylistEditor(urn);}).catch(function(err){toast(err.message,true);}); };
      $('pl-tracks').addEventListener('click', function(e){
        var b=e.target.closest('button'); if(!b) return;
        var order=(p.tracks||[]).map(function(t){return urnOf(t);});
        if(b.hasAttribute('data-remove')){ var r=b.getAttribute('data-remove');
          api('/api/playlists/'+encodeURIComponent(urn)+'/tracks',{method:'POST',body:{remove:[r]}}).then(function(){closeModal();openPlaylistEditor(urn);}).catch(function(err){toast(err.message,true);}); return; }
        var idx=parseInt(b.getAttribute('data-idx'),10); var dir=b.getAttribute('data-move');
        if(isNaN(idx)) return; var j=dir==='up'?idx-1:idx+1; if(j<0||j>=order.length) return;
        var tmp=order[idx]; order[idx]=order[j]; order[j]=tmp;
        api('/api/playlists/'+encodeURIComponent(urn)+'/tracks',{method:'POST',body:{order:order}}).then(function(){closeModal();openPlaylistEditor(urn);}).catch(function(err){toast(err.message,true);});
      });
    }).catch(function(err){ toast(err.message,true); });
  }

  function paintSocial(){
    function list(id, users, action){
      var box=$(id); if(!users.length){ box.className='empty'; box.textContent='Nobody here.'; return; }
      box.className=''; box.innerHTML=users.map(function(u){ var un=urnOf(u);
        return '<div class="row between" style="padding:7px 0;border-bottom:1px solid #1a1a1a"><div class="row"><img class="avatar" style="width:28px;height:28px" src="'+esc(avatar(u.avatar_url,u.username))+'"/>'+
          '<div><div class="small">'+esc(u.username)+'</div><div class="small muted">'+fmtNum(u.followers_count)+' followers</div></div></div>'+
          '<button data-social="'+action+'" data-urn="'+esc(un)+'">'+action+'</button></div>'; }).join('');
    }
    list('social-followers', state.followers, 'follow');
    list('social-followings', state.followings, 'unfollow');
    var likes=$('social-likes');
    if(!state.likes.length){ likes.className='empty'; likes.textContent='No liked tracks.'; }
    else { likes.className=''; likes.innerHTML=tableHtml(state.likes,false); }
  }
  document.addEventListener('click', function(e){
    var b=e.target.closest('button[data-social]'); if(!b) return; var act=b.getAttribute('data-social'); var un=b.getAttribute('data-urn');
    var path = act==='follow'?'/api/social/follow':(act==='unfollow'?'/api/social/follow':'/api/social/like');
    api(path,{method:'POST',body:{urn:un,action:act}}).then(function(){toast('Done');loadState();}).catch(function(err){toast(err.message,true);});
  });

  function paintSettings(){
    var me=state.me||{};
    ['username','full_name','city','country','website','website_title','description'].forEach(function(k){ var el=$('pf-'+k); if(el) el.value=me[k]||''; });
    $('settings-endpoints').innerHTML = ['/api/state','/api/upload','/api/tracks','/api/playlists','/api/social/like','/api/events'].map(function(p){return '<div>'+esc(location.origin+p)+'</div>';}).join('');
  }
  $('save-profile').onclick=function(){
    var body={}; ['username','full_name','city','country','website','website_title','description'].forEach(function(k){ var v=$('pf-'+k).value.trim(); if(v) body[k]=v; });
    api('/api/profile',{method:'POST',body:body}).then(function(){toast('Profile saved');loadState();}).catch(function(err){toast(err.message,true);});
  };
  $('avatar-btn').onclick=function(){ $('avatar-input').click(); };
  $('avatar-input').onchange=function(){ var f=$('avatar-input').files[0]; if(!f) return; var fd=new FormData(); fd.append('file',f);
    api('/api/profile/avatar',{method:'POST',body:fd}).then(function(){toast('Avatar updated');loadState();}).catch(function(err){toast(err.message,true);}); };

  function field(label,id,value){ return '<div class="field"><label>'+esc(label)+'</label><input id="'+id+'" value="'+esc(value||'')+'"/></div>'; }
  function openModal(html){ $('modal-body').innerHTML=html; $('modal').classList.add('open'); }
  function closeModal(){ $('modal').classList.remove('open'); $('modal-body').innerHTML=''; }
  $('modal').addEventListener('click', function(e){ if(e.target===$('modal')) closeModal(); });
  document.addEventListener('keydown', function(e){ if(e.key==='Escape') closeModal(); });

  // ── Upload queue ───────────────────────────────────────────────────────────
  var queue = [];
  var drop=$('drop'), input=$('file-input');
  drop.onclick=function(){ input.click(); };
  drop.ondragover=function(e){ e.preventDefault(); drop.classList.add('hover'); };
  drop.ondragleave=function(){ drop.classList.remove('hover'); };
  drop.ondrop=function(e){ e.preventDefault(); drop.classList.remove('hover'); addFiles(e.dataTransfer.files); };
  input.onchange=function(){ addFiles(input.files); input.value=''; };
  function addFiles(files){ for(var i=0;i<files.length;i++){ queue.push({file:files[i],status:'queued',percent:0,id:'up_'+Math.random().toString(36).slice(2,10)}); } renderQueue(); pump(); }
  function renderQueue(){
    var box=$('queue');
    if(!queue.length){ box.innerHTML=''; return; }
    box.innerHTML=queue.map(function(q){
      return '<div class="qitem"><div class="row between"><div><div class="small" style="font-weight:600">'+esc(q.file.name)+'</div>'+
        '<div class="small muted">'+fmtBytes(q.file.size)+' · '+esc(q.status)+'</div></div>'+
        (q.trackUrn?'<a href="'+esc(q.link||'#')+'" target="_blank" rel="noreferrer" class="small">open</a>':'<span class="small muted">'+q.percent+'%</span>')+'</div>'+
        '<div class="bar" style="margin-top:8px"><i style="width:'+q.percent+'%"></i></div>'+
        (q.error?'<div class="small" style="color:#ffb4b4;margin-top:6px">'+esc(q.error)+'</div>':'')+'</div>';
    }).join('');
  }
  function fmtBytes(n){ if(n>1073741824) return (n/1073741824).toFixed(1)+' GB'; if(n>1048576) return (n/1048576).toFixed(1)+' MB'; if(n>1024) return (n/1024).toFixed(0)+' KB'; return n+' B'; }
  function pump(){
    var next=queue.filter(function(q){return q.status==='queued';})[0];
    if(!next) return;
    next.status='uploading'; renderQueue();
    var meta={sharing:$('up-sharing').value,genre:$('up-genre').value,tags:$('up-tags').value,artist:$('up-artist').value};
    var fd=new FormData(); fd.append('upload_id',next.id); fd.append('metadata',JSON.stringify(meta)); fd.append('file',next.file);
    var xhr=new XMLHttpRequest(); xhr.open('POST','/api/upload'); xhr.setRequestHeader('x-scmcp-csrf','1');
    xhr.upload.onprogress=function(e){ if(e.lengthComputable){ next.percent=Math.min(99,Math.round(e.loaded/e.total*100)); renderQueue(); } };
    xhr.onload=function(){
      var body=null; try{ body=JSON.parse(xhr.responseText); }catch(e){}
      if(xhr.status>=200&&xhr.status<300&&body&&body.track){
        next.status='done'; next.percent=100; next.trackUrn=body.track.urn||('soundcloud:tracks:'+body.track.id); next.link=body.track.permalink_url;
        toast('Uploaded: '+body.track.title); loadState();
      } else { next.status='failed'; next.error=(body&&(body.message||body.error))||('HTTP '+xhr.status); toast('Upload failed: '+next.error,true); }
      renderQueue(); pump();
    };
    xhr.onerror=function(){ next.status='failed'; next.error='network error'; renderQueue(); pump(); };
    xhr.send(fd);
  }
  var es=new EventSource('/api/events');
  es.addEventListener('message', function(e){ try{ var ev=JSON.parse(e.data);
    if(ev.type==='upload.progress'){ var q=queue.filter(function(x){return x.id===ev.uploadId;})[0]; if(q){ q.status='server '+ev.percent+'%'; q.percent=ev.percent; renderQueue(); } }
    if(ev.type==='log' && ev.level==='error'){ toast(ev.message,true); }
  }catch(err){} });
  es.onerror=function(){ /* browser reconnects automatically */ };

  // ── Audio lab ──────────────────────────────────────────────────────────────
  var alResultPath = null;
  function alPath(){ return $('al-path').value.trim(); }
  function alTags(){
    var map={title:'title',artist:'artist',album:'album',album_artist:'album_artist',genre:'genre',year:'year',track:'track',disc:'disc',bpm:'bpm',isrc:'isrc',comment:'comment',lyrics:'lyrics'};
    var tags={};
    Object.keys(map).forEach(function(k){ var v=$('al-'+k).value.trim(); if(v) tags[map[k]]=v; });
    return tags;
  }
  function alInfoHtml(info){
    var t=info.tags||{};
    return '<div class="card" style="background:#0d0d0d"><div class="row between"><div><div style="font-weight:700">'+esc(info.path)+'</div>'+
      '<div class="small muted">'+fmtDur((info.duration_seconds||0)*1000)+' · '+fmtBytes(info.size)+' · '+esc(info.codec)+' · '+(info.bitrate?Math.round(info.bitrate/1000)+' kbps':'?')+' · '+(info.sample_rate||'?')+' Hz · '+(info.channels||'?')+' ch</div></div></div>'+
      '<div class="small muted" style="margin-top:6px">ID3: '+esc([t.title,t.artist,t.album].filter(Boolean).join(' — ')||'none')+'</div></div>';
  }
  function fillAudioForm(tags){
    ['title','artist','album','album_artist','genre','year','track','disc','bpm','isrc','comment','lyrics'].forEach(function(k){
      var el=$('al-'+k); if(el) el.value = tags && tags[k] ? tags[k] : '';
    });
  }
  function setAlResult(html){ $('al-result').innerHTML = html; }
  function useResult(path){
    alResultPath = path;
    setAlResult('<div class="small">Result: <span class="mono">'+esc(path)+'</span> <button id="al-use-result">Use as input</button></div>');
    var b=$('al-use-result'); if(b) b.onclick=function(){ $('al-path').value=path; $('al-probe').click(); };
  }
  $('al-stage').onclick=function(){
    var f=$('al-stage-file').files[0]; if(!f){ toast('Choose an audio file'); return; }
    var fd=new FormData(); fd.append('file',f);
    api('/api/audio/stage',{method:'POST',body:fd}).then(function(result){
      $('al-path').value=result.file_path; toast('Staged: '+result.filename); $('al-probe').click();
    }).catch(function(err){ toast(err.message,true); });
  };
  $('al-probe').onclick=function(){
    var path=alPath(); if(!path){ toast('Enter a file path'); return; }
    api('/api/audio/probe',{method:'POST',body:{file_path:path}}).then(function(info){
      $('al-info').innerHTML=alInfoHtml(info); fillAudioForm(info.tags||{});
      $('al-up-title').value=(info.tags&&info.tags.title)||''; $('al-up-artist').value=(info.tags&&info.tags.artist)||''; $('al-up-genre').value=(info.tags&&info.tags.genre)||'';
      alResultPath=null; setAlResult('');
    }).catch(function(err){ toast(err.message,true); });
  };
  $('al-save-tags').onclick=function(){
    var path=alPath(); if(!path){ toast('Enter a file path'); return; }
    var body={file_path:path, tags:alTags()};
    var out=$('al-output').value.trim(); if(out) body.output_path=out;
    api('/api/audio/tags',{method:'POST',body:body}).then(function(result){
      toast('Tags saved'+(result.backup_path?' (backup: '+result.backup_path+')':''));
      useResult(result.path); $('al-path').value=result.path; $('al-probe').click();
    }).catch(function(err){ toast(err.message,true); });
  };
  $('al-save-art').onclick=function(){
    var path=alPath(); var f=$('al-artwork').files[0];
    if(!path||!f){ toast('Path and image required'); return; }
    var fd=new FormData(); fd.append('file_path',path); fd.append('file',f);
    var out=$('al-output').value.trim(); if(out) fd.append('output_path',out);
    api('/api/audio/artwork',{method:'POST',body:fd}).then(function(result){
      toast('Artwork saved'); useResult(result.path); $('al-path').value=result.path; $('al-probe').click();
    }).catch(function(err){ toast(err.message,true); });
  };
  $('al-remove-art').onclick=function(){
    var path=alPath(); if(!path){ toast('Enter a file path'); return; }
    api('/api/audio/tags',{method:'POST',body:{file_path:path,tags:{},remove_artwork:true}}).then(function(result){
      toast('Artwork removed'); $('al-probe').click();
    }).catch(function(err){ toast(err.message,true); });
  };
  function alProcess(operation, extra){
    var path=alPath(); if(!path){ toast('Enter a file path'); return; }
    var body=Object.assign({file_path:path,operation:operation}, extra||{});
    var out=$('al-output').value.trim(); if(out) body.output_path=out;
    setAlResult('<div class="small muted">Processing '+esc(operation)+'…</div>');
    api('/api/audio/process',{method:'POST',body:body}).then(function(result){
      toast(operation+' done in '+Math.round(result.elapsed_ms/1000)+'s');
      setAlResult('<div class="small">'+alInfoHtml(result.output)+
        '<div style="margin-top:8px"><span class="mono">'+esc(result.output_path)+'</span> <button id="al-use-result">Use as input</button></div>'+
        (result.warnings&&result.warnings.length?'<div class="small" style="color:#ffc9b8">'+esc(result.warnings.join('; '))+'</div>':'')+'</div>');
      alResultPath=result.output_path;
      var b=$('al-use-result'); if(b) b.onclick=function(){ $('al-path').value=result.output_path; $('al-probe').click(); };
    }).catch(function(err){ setAlResult(''); toast(err.message,true); });
  }
  $('al-apply-speed').onclick=function(){
    alProcess($('al-mode').value, {ratio:Number($('al-ratio').value), algorithm:$('al-algorithm').value, ...( $('al-mode').value==='both'?{pitch:Number($('al-ratio').value)}:{})});
  };
  $('al-normalize').onclick=function(){ alProcess('normalize',{target_lufs:Number($('al-lufs').value),true_peak:Number($('al-tp').value)}); };
  $('al-trim').onclick=function(){
    var extra={start_seconds:Number($('al-start').value)||0};
    if($('al-end').value.trim()) extra.end_seconds=Number($('al-end').value);
    alProcess('trim',extra);
  };
  $('al-convert').onclick=function(){ alProcess('convert',{format:$('al-format').value,bitrate_kbps:Number($('al-bitrate').value)||320}); };
  $('al-upload').onclick=function(){
    var path=alResultPath||alPath(); if(!path){ toast('No file'); return; }
    var metadata={};
    ['title','artist','genre','tags','sharing'].forEach(function(k){ var el=$('al-up-'+k); if(el&&el.value.trim()) metadata[k]=el.value.trim(); });
    if(metadata.tags) metadata.tags=metadata.tags.split(',').map(function(s){return s.trim();}).filter(Boolean);
    api('/api/audio/upload',{method:'POST',body:{file_path:path,metadata:metadata}}).then(function(result){
      toast('Uploaded: '+result.track.title); loadState();
    }).catch(function(err){ toast(err.message,true); });
  };

  loadState();
})();
</script>
</body></html>`;
}
