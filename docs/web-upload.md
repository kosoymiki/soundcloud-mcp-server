# Web-session uploads (no API app required)

SoundCloud currently gates API app registration to Artist Pro accounts, so the
official `POST /tracks` route in [`src/soundcloud/api.ts`](../src/soundcloud/api.ts)
is not available to every account. The web uploader at
`https://soundcloud.com/n/upload` still allows any logged-in user to publish
tracks, and this module drives it directly.

## How it works

SoundCloud's Next.js uploader exposes its upload primitives as **private server
actions**. Their ids are deployment-specific; a stale id makes the server answer
`409 x-nextjs-action-not-found: 1`, so ids are never hard-coded:

1. `WebActionSession` launches (or connects to) headless Chromium on a CDP port,
   imports the exported SoundCloud cookies, and opens the real upload page.
2. It reads the page's live chunk graph from `performance.getEntriesByType("resource")`,
   follows the lazy-chunk loader maps, and parses every
   `createServerReference("<id>", …, "<name>")` pair.
3. It installs a small extra Turbopack module in the page so the app's own
   `callServer` runtime is available to Node:
   `TURBOPACK.push([chunkPath, moduleId, factory])` registers the factory and
   `TURBOPACK.push([chunkPath, {otherChunks: [], runtimeModuleIds: [moduleId]}])`
   executes it.
4. The uploader then performs the same sequence the browser performs:

```text
createUploadPolicyAction(fileName, size, mimeType)
  -> { url, method: "PUT", uid, headers[] }        presigned S3 upload
PUT <url>  (policy headers minus Host/Content-Length/Expect, plus Content-Type)
createTrackAction({ uid, trackInput })             single object argument (Next encodes it as [{...}])
createAlbumAction({ createPlaylist })              optional; omit imageData when no artwork
addToPlaylistAction({ trackUrns, playlistUrn })    append to an existing album (registered on /n/album/<id>)
```

The returned `uid` from the policy is the upload token (`<id>.new`);
`trackInput` carries title, permalink, genre, tags, description, share access,
publisher metadata, preview clip, license, and feature flags. After the track is
created SoundCloud transcodes it asynchronously; `getTrackInfoAction` (also a
private action) can be used to read it back.

## Requirements

- Chromium or Google Chrome available as `chromium-browser` (Termux/Android) or
  any binary pointed to by `SC_WEB_CHROME`.
- Exported SoundCloud cookies from a logged-in browser session, in the format
  produced by [`scripts/stealth-import-cookies.py`](../scripts/stealth-import-cookies.py):

```json
{ "cookies": [ { "name": "oauth_token", "value": "…", "domain": "soundcloud.com", "path": "/", "secure": true, "httpOnly": true } ] }
```

The session needs `oauth_token`, `oauth_refresh_token`, `sc_session` and the
DataDome cookie; the export script captures all of them.

## CLI

```bash
npm run build

# List the live private actions (diagnostic; changes with every deployment)
node dist/web/cli.js actions

# Upload a file and create an album that contains it
node dist/web/cli.js upload \
  --file /storage/emulated/0/Music/Telegram/song.mp3 \
  --title song --artist aero --genre Electronic --tags "demo,2026" \
  --album song --album-type ALBUM --verify

# Upload a file and append it to an existing album
node dist/web/cli.js upload \
  --file /storage/emulated/0/Music/Telegram/next.mp3 \
  --title second-song --album-urn soundcloud:playlists:123456789

# Create an album from existing tracks
node dist/web/cli.js album --title song --tracks soundcloud:tracks:123456789
```

The CLI prints JSON: the upload policy uid, S3 status/ETag (verified against the
local MD5), the created track and album, and the read-back track when `--verify`
is used.

## MCP tools

| Tool | Purpose |
|---|---|
| `web_upload_track` | Upload through the web session; optional album creation (`album_title`) or append to an existing album (`album_urn`) and read-back verification |
| `web_create_album` | Create an album/EP from existing track URNs |
| `web_actions` | List the live private server actions (diagnostic) |

These complement the API tools: `upload_track` uses the official API and only
works when an API app is registered; the `web_*` tools work with a plain web
login.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `SC_WEB_CHROME` | `chromium-browser` | Chrome/Chromium binary |
| `SC_WEB_COOKIE_FILE` | `~/.local/share/soundcloud-mcp/chrome-soundcloud-cookies.json` | exported cookie JSON |
| `SC_WEB_UPLOAD_URL` | `https://soundcloud.com/n/upload` | upload page |
| `SC_WEB_DEBUG_PORT` | `9333` | CDP port; reuses an existing browser on that port |
| `SC_WEB_HEADLESS` | `true` | run headless |
| `SC_WEB_TIMEOUT_MS` | `90000` | page/navigation timeout |
| `SC_WEB_CLIENT_ID` | JWT claim | override the api-v2 `client_id` used for verification |

## Troubleshooting

- **`409 x-nextjs-action-not-found`** — an action id from an older deployment.
  Re-run discovery (`web_actions`); the module always reads live ids.
- **Drop/click does nothing** — SoundCloud's OneTrust consent preference center
  can cover the uploader and swallow events. The session clicks
  `#accept-recommended-btn-handler` (or the close button) before interacting.
- **`UnrecognizedActionError`** — the action id was resolved from a cached chunk.
  Only chunks served by the live page are used.
- **No cookies / unauthorized** — re-export cookies after logging in again;
  `oauth_token` expires (typically 24 h).
- **DataDome** — direct GraphQL mutations from the browser are challenged.
  This module never bypasses that: it calls SoundCloud's own server actions,
  which run server-side. No CAPTCHA or bot-protection bypass is performed.
- **`api-v2` verification 401** — set `SC_WEB_CLIENT_ID` to the web app client id
  from the page config.

## Security

The cookie file is a credential. Keep it `chmod 600`, never commit it, and
prefer a per-device data directory. The module acts as the logged-in user; it
does not create accounts, bypass paywalls, or defeat bot protection.
