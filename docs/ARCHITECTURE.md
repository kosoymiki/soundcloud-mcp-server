# Architecture

## Overview

```
┌──────────────────────┐        ┌──────────────────────────────┐
│ MCP client           │        │ Browser (panel)              │
│ (opencode2, Claude…) │        │ /panel                       │
└─────────┬────────────┘        └──────────────┬───────────────┘
          │ Streamable HTTP                    │ HttpOnly cookie
          ▼                                    ▼
┌───────────────────────────────────────────────────────────────┐
│ Express server (src/server.ts)                                │
│  /mcp ── Authenticator ── McpSessionManager ── McpServer      │
│  /panel + /api/* ── Authenticator ── panel router             │
│  /oauth/* + /.well-known/* ── authorization server            │
│  /soundcloud/callback ── token exchange ── encrypted store    │
└───────────────┬───────────────────────────────────────────────┘
                │ Authorization: OAuth <sc access token>
                ▼
┌───────────────────────────────────────────────────────────────┐
│ SoundCloud API (api.soundcloud.com)                           │
│  /me, /tracks, /playlists, /users, /likes, /reposts, …        │
└───────────────────────────────────────────────────────────────┘
```

## Modules

| Module | Responsibility |
|---|---|
| `src/config.ts` | env parsing, data dir, generated secrets, limits |
| `src/logger.ts` | structured JSON logs with secret redaction |
| `src/errors.ts` | typed `AppError` codes and MCP error rendering |
| `src/util/ids.ts` | numeric id / URN / API-URL normalization |
| `src/util/ttl.ts` | TTL map for sessions, codes, clients |
| `src/util/async.ts` | abortable sleep, Retry-After, jitter, single-flight |
| `src/auth/crypto.ts` | PKCE, AES-256-GCM seal/open, HMAC-signed values, hashes |
| `src/auth/store.ts` | encrypted state: connections, MCP tokens, codes, clients |
| `src/auth/tokenService.ts` | SoundCloud access/refresh with rotation + single-flight |
| `src/auth/oauth.ts` | RFC 8414/9728/7591 endpoints, login page, callback, token |
| `src/http/auth.ts` | bearer/cookie/loopback authentication and session identity |
| `src/mcp/sessions.ts` | session TTL, cap, token binding, cleanup |
| `src/mcp/server.ts` | MCP server factory and tool registration |
| `src/soundcloud/http.ts` | retries, timeouts, pagination, error mapping, SSRF guard |
| `src/soundcloud/api.ts` | endpoint methods, URNs, upload/artwork, stream expiry |
| `src/soundcloud/multipart.ts` | streaming multipart with exact Content-Length |
| `src/soundcloud/id3.ts` | ID3v2 text frames and APIC artwork reader |
| `src/uploads/service.ts` | path allowlist, ID3 merge, artwork, progress events |
| `src/panel/api.ts` | panel REST API, login/logout, SSE, busboy uploads |
| `src/panel/ui.ts` | server-rendered panel and browser sign-in pages |
| `src/web/actions.ts` | Chromium/CDP session, live action discovery, `callServer` bridge, api-v2 GET/DELETE |
| `src/web/upload.ts` | upload policy -> S3 PUT -> createTrack/createAlbum/addToPlaylist, verify/delete helpers |
| `src/web/cookies.ts` | Chrome cookie DB staging (root on Android), OSCrypt v10 decryption, 0600 export, token refresh |
| `src/web/doctor.ts` | cookie/token/Chromium health and live session probe |
| `src/web/selftest.ts` | end-to-end runtime chain with automatic cleanup |
| `src/web/cli.ts` | `cookies`, `doctor`, `selftest`, `upload`, `album`, `actions` commands |
| `src/events.ts` | in-process event bus for SSE |

## Token flows

### Browser panel

1. `GET /panel` → no cookie and no loopback auto-login → `/panel/login`.
2. `GET /panel/auth/start` → PKCE pair + random state stored in the TTL map
   (`kind: "panel"`), redirect to `secure.soundcloud.com/authorize`.
3. SoundCloud redirects to `${PUBLIC_URL}/soundcloud/callback`.
4. Callback exchanges the code at `secure.soundcloud.com/oauth/token` with the
   client id/secret, stores an encrypted `Connection`, issues an MCP access
   token for the panel, and sets the HttpOnly cookie.
5. `GET /panel` → cookie → access token → connection → SoundCloud API.

### MCP client through the authorization server

1. Client registers (`POST /register`) with its redirect URI.
2. `GET /oauth/authorize` validates client and redirect URI. With env app
   credentials it redirects straight to SoundCloud; without them it renders a
   one-time form bound to a signed flow cookie.
3. Callback stores the connection and redirects back to the client with a
   single-use authorization code.
4. `POST /oauth/token` verifies PKCE and issues `scmcp_at_…` + `scmcp_rt_…`.
5. `POST /mcp` authenticates the token, creates a transport/session, and binds
   the session to the token hash.

### Local/headless mode

`SC_ACCESS_TOKEN` (plus optional `SC_REFRESH_TOKEN`) is loaded into a `local`
connection at startup. MCP clients send `MCP_LOCAL_TOKEN` as a bearer token, or
loopback browser requests reuse the local connection without a cookie.

## Upload pipeline

```
tool/panel → UploadService.resolvePath (realpath + roots + extension + size)
           → ID3 read (missing fields only)
           → createMultipart(fields, file)
                pull-based ReadableStream: header → 1 MiB file chunks → footer
           → HttpClient.requestRaw (Content-Length, no replay on retry)
           → POST /tracks (multipart/form-data)
           → 201 track JSON
           → optional PUT /tracks/{urn} with APIC artwork (warning on failure)
           → progress events through EventBus/SSE and MCP notifications
```

Retries rebuild the multipart body rather than reusing the consumed stream; a
401 forces one token refresh before the retry.

## Persistence

`DATA_DIR/state.enc` is a single AES-256-GCM-sealed JSON document:

```json
{
  "version": 1,
  "connections": [{ "id": "...", "scAccessToken": "...", "scRefreshToken": "..." }],
  "tokens": [{ "hash": "...", "connectionId": "...", "kind": "access" }]
}
```

Writes are atomic (`tmp` + `rename`, `0600`). Dynamic clients, login states and
authorization codes intentionally live only in memory.

## Failure modes

| Symptom | Cause | Handling |
|---|---|---|
| 401 from SoundCloud | expired access token | one forced refresh, then retry |
| invalid_grant on refresh | single-use token burned | `needsReauth`, panel shows Reconnect |
| 429 | rate limit | Retry-After or jittered backoff, bounded |
| 5xx on GET/upload | transient | bounded retry; multipart rebuilt |
| 406 on `/mcp` | client did not accept SSE | explicit error, no retry loop |
| 403 on upload path | outside `SC_MEDIA_DIRS` | typed `FORBIDDEN` before reading |
| 413 | file over cap | typed `UPLOAD_TOO_LARGE` |

## Audio lab pipeline

```
panel / MCP audio_* tool
  → UploadService.resolvePath (media roots, extension, size)
  → AudioService.probe (ffprobe JSON + ID3 tags)
  → operation:
       ID3 edit:  id3File.writeTags (temp tag + streamed audio + .bak + rename)
       ffmpeg:    spawn(ffmpeg, args) with -progress pipe:1
                  filters: rubberband/atempo/asetrate/loudnorm/atrim
                  codec:   libmp3lame 320k | pcm_s16le | flac
                  then re-apply ID3 tags/artwork to the MP3 output
  → probe output → return paths, tags and warnings
```

`AudioService` caches the filter list (`ffmpeg -filters`) and prefers
`rubberband` for tempo/pitch when present; `atempo` is used as a fallback and
is chained for old builds. Outputs are named `<name>.<operation><ratio>.<ext>`
and never overwrite silently.

SoundCloud does not allow replacing audio after upload, so edited files are
uploaded as new tracks; the server does not simulate an in-place replace.

## Design decisions

- **Server-issued MCP tokens** instead of passthrough: required by the MCP
  authorization spec and isolates SoundCloud credentials from clients.
- **Opaque tokens stored hashed**: no JWT signing key to manage; revocation is
  immediate; no claims to validate.
- **Streaming multipart**: SoundCloud accepts up to 4 GB; buffering is not an
  option on Android/Termux.
- **URN-first identifiers**: the 2026 OpenAPI marks numeric ids as deprecated.
- **Server-rendered panel**: no build step for the UI, no third-party JS, CSP
  with a nonce, and the same auth/session model as the API.
- **In-memory OAuth codes/clients**: short-lived and safer than persisting them;
  servers must be single-replica for OAuth sessions.

## MCP transports

Two endpoints share one tool source (`src/tools/*`):

- `/mcp` — Streamable HTTP on the official SDK (protocol `2025-11-25`), legacy
  `initialize` handshake, session manager with token binding.
- `/mcp-v2` — modern era (`2026-07-28`) through `@prefecthq/fastmcp-ts`; each
  request carries `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` (for
  `resources/read` / `prompts/get`) and the `io.modelcontextprotocol/*` `_meta`
  envelope. Tools are registered per SoundCloud connection so handlers keep their
  bound `ToolContext`; resources and prompts come from `src/mcp/resources.ts`.

`tools/list` is returned in pages of 50 with `nextCursor`.

## Web-session runtime

The upload path that does not need an API app:

```text
cookies -> live session (/me) -> createAlbumAction
        -> createUploadPolicyAction -> presigned S3 PUT (MD5 checked)
        -> createTrackAction -> addToPlaylistAction
        -> read-back (getTrackInfoAction + api-v2) -> delete track + album
```

Action ids are deployment-specific and discovered from the live client bundle;
the bridge injects a Turbopack module to reach the app's own `callServer`.
Cookies are exported from the browser profile into `DATA_DIR` (0600, never inside
a git work tree) and can be refreshed by re-reading the profile or, as a
fallback, by exchanging `oauth_refresh_token`.
