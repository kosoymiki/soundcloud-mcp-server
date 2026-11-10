---
name: soundcloud-mcp-server
description: Work on the soundcloud-mcp-server project (50-tool MCP server, panel, audio lab, web-session uploader). Use when installing, running, debugging, extending, or uploading/managing SoundCloud content through this repo. Self-contained: no H2/opencode-internal knowledge required.
---

# soundcloud-mcp-server — project master skill

## What this project is

A self-hosted **MCP server for SoundCloud** plus a browser panel and local audio
lab. It exposes 55 MCP tools over Streamable HTTP (`/mcp`), a REST panel
(`/panel`), and two upload paths:

1. **Official API** (`api.soundcloud.com`) — needs a registered SoundCloud app
   (currently Artist Pro-gated).
2. **Web session** (`src/web/`) — drives the real soundcloud.com uploader with
   exported browser cookies: presigned S3 upload, private server actions
   discovered from the live bundle, track/album creation. Works without an API app.

Users may be non-technical: **guide them step by step** and never ask for their
SoundCloud password.

## Golden path (what to do, in order)

1. **Install** (Termux/Linux/macOS):
   `bash install-termux.sh` (Termux: installs node/ffmpeg/chromium/python-numpy,
   then `npm ci`, build, tests). Manual: `npm ci && npm run build && npm test`.
2. **Configure**: copy `.env.example` → `.env`; set `PUBLIC_URL`, `MCP_MODE`,
   `SC_MEDIA_DIRS`, audio paths. `DATA_DIR` defaults to
   `~/.local/share/soundcloud-mcp` (0700).
3. **Choose auth**:
   - *API app*: `node scripts/sc.mjs auth --client-id … --client-secret …`
     (only if the user can register an app; otherwise use web session).
   - *Web session*: user logs in to soundcloud.com in a browser, exports cookies
     with `scripts/stealth-import-cookies.py`, `chmod 600` the JSON, sets
     `SC_WEB_COOKIE_FILE`. No password sharing.
4. **Run**: `npm start` → panel `http://localhost:3000/panel`, MCP
   `http://localhost:3000/mcp` (Bearer `MCP_LOCAL_TOKEN` or OAuth discovery).
5. **Verify**: `npm run typecheck && npm test` (64 tests), `curl /health`,
   open `/panel` (redirects to login), POST `/mcp` without token → 401 +
   `WWW-Authenticate`.

## Protocol support

Two MCP endpoints serve the same 55 tools, the `soundcloud://guide` resource and
the `plan_upload` prompt: `/mcp` (legacy **2025-11-25**, official SDK 1.32.2) and
`/mcp-v2` (modern **2026-07-28**, FastMCP 1.9.1, tools registered per SoundCloud
connection). Modern requests need `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`
for reads/gets, and the `io.modelcontextprotocol/*` `_meta` envelope. The MCP
layer is isolated in `src/mcp/`; auth/panel/web-session/audio are shared.

## Architecture (file map)

| Layer | Files | Responsibility |
|---|---|---|
| HTTP server | `src/server.ts` | Express, security headers/CORS/rate limits, `/mcp`, panel mount |
| MCP | `src/mcp/*` | server factory, session manager |
| Tools | `src/tools/*` | 55 MCP tools (profile, tracks, playlists, social, audio, web) |
| SoundCloud API | `src/soundcloud/*` | REST client, HTTP, multipart, ID3 |
| Auth | `src/auth/*` | OAuth+PKCE, encrypted store, token service, crypto |
| Uploads | `src/uploads/*` | staging + upload service |
| Audio lab | `src/audio/*` | ffmpeg engine, ID3 writer, trim/speed/normalize/convert |
| Panel | `src/panel/*` | REST API + single-file UI (nonce CSP) |
| Web session | `src/web/*` | Chromium/CDP, live action discovery, uploader, CLI |
| Verification | `tests/` | 64 unit tests; `scripts/e2e.mjs` mock E2E |

Data flow (web upload): `createUploadPolicyAction(name,size,mime)` →
PUT presigned S3 → `createTrackAction({uid,trackInput})` → optional
`createAlbumAction({createPlaylist})` or `addToPlaylistAction({trackUrns,playlistUrn})`.

## Web-session pipeline (critical knowledge)

- **Runtime chain (one command):** `node dist/web/cli.js selftest` — cookies →
  live session → empty album → private upload (presigned S3, MD5 checked) →
  `createTrackAction` → `addToPlaylistAction` → read-back → delete track+album.
  `--keep` leaves the artifacts for inspection.
- **Fresh cookies:** `node dist/web/cli.js cookies` reads the local Chrome DB
  (root-staged on Android), decrypts OSCrypt `v10` and writes 0600 JSON;
  `doctor --probe` verifies the live account and action count.
- The uploader lives in a **lazy Next.js chunk**; action ids are per deployment.
  Discover them from the live page (`web_actions` tool or
  `scripts/page-actions.mjs`), never hardcode. Stale ids → `409
  x-nextjs-action-not-found`.
- The bridge injects a tiny Turbopack module into the page (two
  `TURBOPACK.push` calls) to reach the app's `callServer`.
- `createTrackAction` takes **one object** `{uid, trackInput}` (Next encodes it
  as `[{...}]`). The `uid` is the policy uid (`<id>.new`).
- `addToPlaylistAction({trackUrns:[urn], playlistUrn})` is registered on
  `/n/album/<id>`; direct api-v2 playlist PUT and GraphQL mutations are
  DataDome-403 — use the server action.
- OneTrust consent can cover the uploader; dismiss it
  (`#accept-recommended-btn-handler` or Escape) before interacting.
- CDP is bound to 127.0.0.1; keep the cookie JSON `chmod 600`.

## Audio lab conventions

- ffmpeg filters used: `highpass`, `lowshelf`, `highshelf`, `equalizer`,
  `deesser`, `acompressor`, `asoftclip`, `alimiter`, `loudnorm`, `asetrate` +
  `aresample` (tape slow), `rubberband` (tempo/pitch independent).
- Trim cuts: put the boundary at a **5 ms RMS local minimum before the next
  attack**; add 10–40 ms fades; avoid cutting a speaker/syllable. Tools:
  `scripts/fine-env.py`, `scripts/boundary.py`, `scripts/speaker-change.py`.
- Slowed edits: tie time+pitch (`asetrate=SR/ratio`); add extra pitch with
  `rubberband=pitch=<ratio>` if tempo must stay. Typical total −3…−5 semitones.
- Master targets for uploads: ≈ −11 LUFS, true peak ≤ −1.0 dBTP, 0 clipped
  samples; verify with `ebur128` and `scripts/analyze-track.py`.
- Never fake a render: measure duration/LUFS/TP and report the numbers.

## Troubleshooting playbook

| Symptom | Cause / fix |
|---|---|
| Server action 409 / UnrecognizedActionError | stale id → rediscover actions |
| DataDome 403 (GraphQL, playlist PUT) | use server actions; do not bypass |
| `api-v2` 401 on verification | set `SC_WEB_CLIENT_ID` |
| Uploader ignores drop/click | consent dialog; dismiss first |
| Old profile/track URL 404 | permalink changed; SoundCloud does not redirect |
| `SC_WEB_CHROME` error | absolute path must be a regular executable |
| Cookie file warning | `chmod 600` the exported cookies |

## Security rules (non-negotiable)

No secrets in the repo; state encrypted AES-256-GCM (0600); tokens hashed at
rest; OAuth PKCE + one-time state; CSRF header + Origin for cookie mutations;
HSTS on https; CORS allowlist; rate limits; no CAPTCHA/paywall/auth bypass and
no credential collection. Keep `.env` and cookie JSON out of version control.

## Definition of done for changes

`npm run typecheck` rc 0, `npm test` 64/64, `npm run build`, live `/health`
smoke, README/env docs updated, no session-specific hardcodes in `src/tests/docs`,
and evidence recorded (commands + outputs).
