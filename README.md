# SoundCloud MCP Server v2 — uploads, studio, web-session automation

Production-grade SoundCloud MCP server: **50 MCP tools**, a browser control
panel, a local audio lab (ffmpeg), and a web-session uploader that works even
when SoundCloud API app registration is unavailable (Artist Pro gating).

- **MCP transport:** Streamable HTTP (`/mcp`) with bearer tokens + OAuth discovery.
- **Panel:** `http://localhost:3000/panel` (7 tabs, nonce CSP, CSRF-protected).
- **Official API path:** `api.soundcloud.com` with a registered app (OAuth).
- **Web-session path:** drives the real `soundcloud.com` uploader/actions via a
  logged-in Chromium session — no file picker, presigned S3 upload, private
  server actions discovered from the live bundle.
- **Audio lab:** probe, ID3 edit, trim, speed/pitch (rubberband), loudness,
  convert — plus analysis/boundary tooling for slowed/edited masters.

## Start here (5 minutes)

```bash
git clone <repo> soundcloud-mcp-server && cd soundcloud-mcp-server
bash install-termux.sh        # Termux: pkg deps + npm ci + build + 48 tests
# non-Termux: npm ci && npm run build && npm test
```

Then edit `.env`, choose authorization (A or B below), `npm start`, and open
`http://localhost:3000/panel`.

**Project master skill (for AI agents):**
[`.opencode/skills/soundcloud-mcp-server/SKILL.md`](.opencode/skills/soundcloud-mcp-server/SKILL.md)
— a self-contained operating guide with the golden path, architecture map,
web-session pipeline, audio-lab conventions, troubleshooting table, security
rules and definition of done. It needs no external H2/agent framework; any model
that can read files can follow it.

## Requirements

| Component | Version / notes |
|---|---|
| Node.js | **>= 20.19** (tested on Node 24) |
| npm | ships with Node |
| ffmpeg / ffprobe | for the audio lab and analysis scripts (`FFMPEG_PATH`, `FFPROBE_PATH`) |
| Chromium / Chrome | only for web-session tools (`SC_WEB_CHROME`, default `chromium-browser`) |
| SoundCloud account | official API app **or** exported web cookies |

Termux/Android: `pkg install nodejs ffmpeg chromium`, use `$PREFIX/tmp` for
scratch, and keep `DATA_DIR` on internal storage (chmod 700).

## Install, build, test

```bash
npm ci                 # or npm install
npm run build          # tsc -> dist/
npm test               # 48 unit tests
npm run typecheck
npm run e2e            # 16-check end-to-end harness (mock SoundCloud)
npm start              # node dist/index.js
```

`npm audit --omit=dev` is clean (0 vulnerabilities at release time).

## Dependencies

Runtime: `@modelcontextprotocol/sdk`, `express`, `busboy`, `zod`,
`puppeteer-core` (web-session automation).
Dev: `typescript`, `tsx`, `@types/node`, `@types/express`, `@types/busboy`.

## Configuration

All settings are environment variables (`.env.example` is the reference).

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `3000` / `127.0.0.1` | listen address |
| `PUBLIC_URL` | `http://localhost:PORT` | public origin; `https://` enables HSTS + Secure cookies |
| `MCP_MODE` | `both` | `local`, `oauth`, `both` |
| `MCP_TRUST_PROXY` | `false` | trust `X-Forwarded-*` (only behind a trusted reverse proxy) |
| `SC_CLIENT_ID` / `SC_CLIENT_SECRET` | — | SoundCloud app credentials (per device) |
| `SC_REDIRECT_URI` | `${PUBLIC_URL}/soundcloud/callback` | must be registered in the app |
| `SC_ACCESS_TOKEN` / `SC_REFRESH_TOKEN` | — | optional headless bootstrap |
| `SC_AUTH_SCHEME` | `OAuth` | `OAuth` (current) or `Bearer` (legacy apps) |
| `SC_API_BASE` / `SC_AUTH_BASE` | production | testing/proxy override |
| `SC_MEDIA_DIRS` | `~` | colon-separated upload/audio path allowlist |
| `SC_MAX_UPLOAD_BYTES` | 4 GiB | hard upload cap |
| `FFMPEG_PATH` / `FFPROBE_PATH` | `ffmpeg` / `ffprobe` | audio lab binaries |
| `AUDIO_WORK_DIR` | `DATA_DIR/edits` | allowed output directory |
| `AUDIO_MAX_CONCURRENT` | `2` | concurrent ffmpeg jobs |
| `DATA_DIR` | `~/.local/share/soundcloud-mcp` | encrypted state, keys, temp uploads (0700) |
| `MCP_ENCRYPTION_KEY` | generated | 32-byte base64 AES-256-GCM key (0600) |
| `MCP_LOCAL_TOKEN` | generated | bearer for non-OAuth MCP clients (0600) |
| `MCP_ACCESS_TOKEN_TTL` / `MCP_REFRESH_TOKEN_TTL` | 7 d / 30 d | server tokens |
| `MCP_SESSION_IDLE_TTL` | 30 min | idle MCP sessions |
| `MCP_PANEL_AUTO_LOGIN` | `true` | reuse a local connection for loopback requests |
| `MCP_OPEN_BROWSER` | `true` | allow `open_auth_window` / `npm run auth` |
| `UI_BRAND_COLOR` | `#f50` | panel accent |
| `LOG_LEVEL` / `MCP_DEBUG` | `info` / `false` | diagnostics |
| `SC_WEB_CHROME` | `chromium-browser` | Chrome/Chromium binary for web-session tools |
| `SC_WEB_COOKIE_FILE` | `DATA_DIR/chrome-soundcloud-cookies.json` | exported SoundCloud cookies (0600!) |
| `SC_WEB_UPLOAD_URL` | `https://soundcloud.com/n/upload` | page used for action discovery |
| `SC_WEB_DEBUG_PORT` | `9333` | CDP port (reuses an existing browser) |
| `SC_WEB_HEADLESS` | `true` | run the web-session browser headless |
| `SC_WEB_TIMEOUT_MS` | `90000` | navigation timeout |
| `SC_WEB_CLIENT_ID` | JWT claim | api-v2 client id used for verification |

## Authorization

### A. Official API (needs a registered app)

Create an app at `https://soundcloud.com/you/apps` (registration is currently
Artist Pro-only; otherwise see B) and register
`${PUBLIC_URL}/soundcloud/callback`. Then:

```bash
node scripts/sc.mjs auth --client-id "$SC_CLIENT_ID" --client-secret "$SC_CLIENT_SECRET"
```

The panel setup page (`/panel/setup`, loopback only) stores credentials
encrypted; the browser OAuth flow issues a server token in an HttpOnly cookie.
No SoundCloud token is ever pasted or copied.

### B. Web session (no API app required)

1. Log in to `soundcloud.com` in a browser.
2. Export cookies to JSON with `scripts/stealth-import-cookies.py` (or any
   exporter producing `{ "cookies": [ { name, value, domain, path, secure, httpOnly } ] }`).
3. `chmod 600` the file and point `SC_WEB_COOKIE_FILE` at it.
4. Use `web_*` tools / `npm run web-upload`.

The server loads the live upload page, discovers the deployment-specific
private server actions, and calls them through the app's own `callServer`
runtime; uploads go to the presigned S3 URL, then `createTrackAction`, optional
`createAlbumAction`, and `addToPlaylistAction` for existing albums.

## MCP tools (50)

**Profile (6):** `get_me`, `get_upload_quota`, `update_profile`,
`upload_avatar`, `get_panel_url`, `open_auth_window`

**Tracks & uploads (10):** `search_tracks`, `get_track`, `list_my_tracks`,
`update_track`, `delete_track`, `upload_track`, `upload_track_artwork`,
`get_stream_url`, `get_track_comments`, `post_comment`

**Playlists (8):** `list_my_playlists`, `get_playlist`, `create_playlist`,
`update_playlist`, `add_tracks_to_playlist`, `remove_track_from_playlist`,
`reorder_playlist`, `delete_playlist`

**Social & discovery (16):** `like_track`, `unlike_track`, `like_playlist`,
`unlike_playlist`, `repost_track`, `unrepost_track`, `follow_user`,
`unfollow_user`, `list_followers`, `list_followings`, `list_likes`,
`list_reposts`, `list_activity`, `search_users`, `search_playlists`,
`resolve_url`

**Audio lab (7):** `audio_probe`, `read_audio_tags`, `edit_audio_tags`,
`change_audio_speed`, `normalize_audio`, `trim_audio`, `convert_audio`

**Web session (3):** `web_upload_track` (optional `album_title` or
`album_urn`), `web_create_album`, `web_actions` (live action discovery)

Lists accept `limit`, `max_items`, opaque `cursor`; IDs accept a numeric id,
`soundcloud:<kind>:<id>` URN, or an `api.soundcloud.com` URL.

## CLI

```bash
npm run cli -- auth|upload|tracks|panel        # scripts/sc.mjs
npm run web-upload -- upload --file song.mp3 --title "Song" --album "My Album"
npm run web-upload -- upload --file song.mp3 --title "Song" --album-urn soundcloud:playlists:<id>
npm run web-upload -- album --title "My Album" --tracks soundcloud:tracks:<id>
npm run web-upload -- actions                  # list live server actions
```

## Analysis & editing scripts

Generic, argument-driven tools (no session data baked in):

| Script | Purpose |
|---|---|
| `scripts/analyze-track.py <file>` | LUFS/peak/clipping, band energies, centroid, stereo correlation |
| `scripts/bpm.py <file>` | tempo estimate (spectral-flux autocorrelation) |
| `scripts/envelope.py <file> <start> <end>` | 20 ms RMS envelope |
| `scripts/fine-env.py <file> <start> <end> [ms]` | 5 ms RMS/peaks for cut points |
| `scripts/boundary.py <file> <start> <end>` | per-frame RMS/centroid/F0/ZCR |
| `scripts/speaker-change.py <file> <start> <end>` | MFCC window dissimilarity (speaker change) |
| `scripts/trim-track.mjs <in> <out> [start] [end]` | trim through the repo AudioService (ID3 preserved) |
| `scripts/replace-track.mjs <oldId> <file> <title> <dur> [albumUrn]` | delete + re-upload + optionally add to album |
| `scripts/add-to-album-action.mjs <playlistUrn> <trackUrn>` | add a track to an existing album |
| `scripts/page-actions.mjs <url>` | list server actions discovered on a page |
| `scripts/web-smoke.mjs [trackUrn] [permalink]` | live web-session smoke test |
| `scripts/s3-put.mjs <policy.json> <file>` | PUT a file to a presigned upload policy |
| `scripts/stealth-import-cookies.py` | import/export browser cookies for web-session tools |
| `scripts/sc.mjs` / `scripts/e2e.mjs` | CLI and mock E2E harness |

Analysis examples:

```bash
python3 scripts/analyze-track.py track.mp3
python3 scripts/bpm.py track.mp3
python3 scripts/fine-env.py track.mp3 116.8 118.2 5
python3 scripts/speaker-change.py track.mp3 114 120
```

`trim-track.mjs` and the audio-lab tools resolve paths through `SC_MEDIA_DIRS`;
include the input directory, e.g.
`SC_MEDIA_DIRS=/storage/emulated/0/Music/Telegram:~ npm run ...`.

## Browser panel

`${PUBLIC_URL}/panel` (login `/panel/login`, setup `/panel/setup` — loopback
only) provides: Overview, Upload (drag & drop queue), Tracks, Playlists,
Social, Audio lab, Settings. Mutations require the CSRF header; pages use a
nonce CSP and no-store caching.

## Security

- Tokens/secrets: AES-256-GCM state, 0600 files, 0700 dirs; logger redacts
  `access_token`/`refresh_token`/`client_secret`.
- Auth: OAuth PKCE + one-time state; server-issued tokens (hashed at rest);
  constant-time local-token compare.
- Panel: HttpOnly/SameSite=Lax cookies (`Secure` on TLS), Origin + `x-scmcp-csrf`
  on cookie-authenticated mutations, nonce CSP, frame-ancestors none.
- HTTP: HSTS when `PUBLIC_URL=https`, `X-Content-Type-Options`, `X-Frame-Options:
  DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy`; CORS allowlist
  (`PUBLIC_URL` + localhost) instead of `*`; rate limits on `/mcp`, OAuth and
  `/panel/auth`.
- Inputs: media path allowlist via `realpath`, body limits, ffmpeg/ffprobe
  spawned with argument arrays (no shell), no `eval` on user input.
- Web session: CDP bound to `127.0.0.1`; cookie file permission warning when
  group/other-readable.

## Project layout

| Path | Role |
|---|---|
| `src/server.ts` | Express app, security headers/CORS, rate limits, MCP endpoint |
| `src/mcp/` | MCP server factory + session manager |
| `src/tools/` | MCP tool registrations (profile/tracks/playlists/social/audio/web) |
| `src/soundcloud/` | API client, HTTP, multipart, ID3 |
| `src/auth/` | OAuth/PKCE, encrypted store, token service, crypto |
| `src/uploads/` | staging + upload service |
| `src/audio/` | ffmpeg engine, ID3 file writer, audio service |
| `src/panel/` | panel router/REST API + single-file UI |
| `src/web/` | web-session transport (CDP/actions), uploader, CLI |
| `tests/` | 48 unit tests (`npm test`) |
| `scripts/` | CLI, E2E, cookie import, analysis/editing tools |
| `docs/` | architecture, API notes, security/web-upload guides |

## Troubleshooting

- **`Application registration is not available`** — app creation is Artist
  Pro-gated; use the web-session path (B).
- **`409 x-nextjs-action-not-found`** — stale action id; rediscover with
  `web_actions` / `page-actions.mjs`.
- **Web drop/click does nothing** — the OneTrust consent dialog can cover the
  uploader; the session dismisses it (`#accept-recommended-btn-handler`/Escape).
- **DataDome** — direct GraphQL/playlist writes from the browser can be
  challenged; the server-action path is the supported route. No bypass is done.
- **Permalink change** — old profile/track URLs 404 (SoundCloud does not
  redirect after a permalink change).
- **`api-v2` verification 401** — set `SC_WEB_CLIENT_ID`.

## License

AGPL-3.0-or-later. Original work Copyright (C) 2026 Marcell Kehmstedt;
fork contributions under the same license.
