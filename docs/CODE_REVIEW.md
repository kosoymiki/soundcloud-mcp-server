# Code review — `marcellkehmstedt/soundcloud-mcp-server`

Review date: **2026-11-09**  
Donor commit: **792e8ca1e061488f33c5ee5c4c642cb563e61ed2** (2026-06-18)  
Reviewer: h2 engineering pass (static analysis + donor build/test + SoundCloud OpenAPI + MCP 2025-06-18)

---

## 1. Header

| Item | Value |
|---|---|
| Donor | `https://github.com/marcellkehmstedt/soundcloud-mcp-server` |
| License | AGPL-3.0-or-later |
| Stack | TypeScript, Express 4, MCP SDK, zod, Node 20 |
| Size | 15 files, 1,885 lines, ~480 KB |
| Baseline build | `npx tsc --noEmit` → rc 0 (observed) |
| Baseline tests | `npm test` → 7 pass / 0 fail (observed) |
| Baseline coverage | only `src/soundcloud/client.test.ts` (playlist ID serialization) |
| Target | production-grade v2 in `./` (this repo), not a patch series |

The donor is a small, readable playlist/track-read MCP server. The baseline build
and tests pass, but the OAuth/token model violates the MCP authorization spec,
several SoundCloud API calls use the wrong scheme/fields, and large feature
areas (upload, profile, social, audio editing, pagination, panel) do not exist.

## 2. What it does

- Express server on `PORT` with `/mcp` (Streamable HTTP), OAuth discovery,
  dynamic client registration, an authorize page, a SoundCloud callback and a
  token endpoint.
- 10 MCP tools: search/get track, stream URL, list/get/create/update/delete
  playlists, add/remove playlist tracks.
- Passes a SoundCloud bearer token through as the MCP bearer token; stores the
  SoundCloud client id/secret inside a base64 refresh token handed to the MCP
  client.
- Dockerfile + compose + one GitHub Actions image-publish workflow.

## 3. Why it needed a review

The tool was being used as the base for a real artist workflow: upload MP3s one
by one, edit track/album metadata after upload, change artwork, and drive the
whole profile from opencode2. The donor has no upload, no profile, no social
actions, no panel, and its auth model cannot safely hold a long-lived
SoundCloud connection. The review therefore covers **security, correctness,
API-spec compliance, feature completeness and missing tests**.

## 4. Where the v2 implementation lives

| Area | Donor | v2 |
|---|---|---|
| Server/entry | `src/index.ts` | `src/server.ts`, `src/index.ts`, `src/config.ts` |
| OAuth/AS | `src/auth/mcpAuth.ts`, `src/auth/pkceStore.ts` | `src/auth/oauth.ts`, `src/auth/store.ts`, `src/auth/crypto.ts`, `src/http/cookies.ts` |
| Token lifecycle | implicit passthrough | `src/auth/tokenService.ts` + hashed opaque tokens in `src/auth/store.ts` |
| SoundCloud client | `src/soundcloud/client.ts` | `src/soundcloud/http.ts`, `src/soundcloud/api.ts`, `src/soundcloud/multipart.ts`, `src/soundcloud/types.ts` |
| Tools | `src/tools/tracks.ts`, `playlists.ts` | `src/tools/{profile,tracks,playlists,social,audio}.ts` (47 tools) |
| Uploads | none | `src/uploads/service.ts`, `src/soundcloud/id3.ts`, streaming multipart |
| Audio lab | none | `src/audio/{id3File,ffmpeg,service}.ts`, `src/tools/audio.ts` |
| Panel | `src/ui/login.html` only | `src/panel/{ui,api}.ts` (studio + REST + SSE) |
| Tests | 1 file / 7 tests | 10 files / 36 tests |

## 5. Why the v2 design is shaped this way

- **Server-issued MCP tokens, not passthrough.** The MCP 2025-06-18
  authorization section requires audience validation and explicitly forbids
  token passthrough. SoundCloud tokens never leave the server; MCP clients get
  opaque `scmcp_at_…` tokens stored as SHA-256 hashes.
- **Browser-first auth.** The panel starts a PKCE flow at
  `secure.soundcloud.com/authorize` and returns to `/soundcloud/callback`; the
  user never copies a token. App credentials come from env (personal device) or
  from a one-time server-side form encrypted at rest (multi-user deploy).
- **Streaming multipart.** SoundCloud accepts up to 4 GB per file; buffering is
  impossible on Android/Termux. The multipart body is a pull-based stream with
  an exact `Content-Length`.
- **URN-first API.** The 2026 OpenAPI marks numeric ids deprecated; playlist
  track objects require `{urn}`, not `{id}`. All tools normalize to URNs.
- **Single-use refresh rotation.** SoundCloud refresh tokens are single-use;
  the server persists the new token before returning and marks `needsReauth`
  on `invalid_grant`.
- **Local audio editing is separate from SoundCloud.** SoundCloud cannot replace
  uploaded audio, so speed/tempo edits produce a new local file which can be
  uploaded as a new track. The UI says this explicitly.

## 6. Bugs and gaps (donor file:line)

Severity: **C**ritical, **H**igh, **M**edium, **L**ow. Status is the v2 fix.

| ID | Sev | Donor location | Finding | Evidence | v2 fix |
|---|---|---|---|---|---|
| C1 | C | `src/index.ts:127-135`, `185`; `README.md:134` | SoundCloud token accepted as MCP bearer token (token passthrough). | MCP 2025-06-18 forbids accepting tokens not issued for the server; no audience check anywhere. | `src/auth/store.ts:169-190`, `src/server.ts:215-245` issue/verify server tokens. |
| C2 | C | `src/auth/mcpAuth.ts:68-78` | Refresh token is unsigned base64 JSON containing `client_secret`. | `Buffer.from(JSON.stringify(payload)).toString("base64url")`; readable/forgeable by the client. | Opaque tokens + AES-GCM state in `src/auth/store.ts:79-290`, `src/auth/crypto.ts:62-100`. |
| C3 | C | `src/index.ts:48-94` | `/diagnostic` is an unauthenticated token proxy returning `/me` (PII) and using any supplied bearer. | No auth middleware, no rate limit. | Authenticated `/diagnostic` with typed output in `src/server.ts:150-190`. |
| C4 | C | `src/index.ts:102-125`, `150-158` | Any non-empty bearer can attach to any existing `mcp-session-id` (session fixation); session map is unbounded and never expires. | No token/session binding, `Map<string, transport>` only. | `src/mcp/sessions.ts:53-56` binding + TTL/cap; `src/server.ts:230-245` 403 on mismatch. |
| C5 | C | `src/auth/mcpAuth.ts:123-167` | Dynamic registration accepts arbitrary redirect URIs; authorize never validates client_id/redirect_uri exact match. | Any `https`/`http` URI accepted; redirect used directly. | `src/auth/oauth.ts:36-55` allowlist; store + exact match at `:270-295`. |
| C6 | C | `src/auth/mcpAuth.ts:141-205` | Login/authorize POST has no CSRF or Origin check; a cross-site form can start an authorization in a victim browser. | No signed flow, no cookie binding. | Signed flow + `SameSite=Lax` cookie in `src/auth/oauth.ts:300-385`. |
| H1 | H | `src/soundcloud/client.ts:40`; `src/index.ts:62,74` | Uses `Authorization: Bearer`; the SoundCloud guide requires `Authorization: OAuth <token>`. | Official guide/OpenAPI `AuthHeader` description. | `src/soundcloud/http.ts:115` configurable `OAuth`/`Bearer`. |
| H2 | H | `src/auth/mcpAuth.ts:28,201` | Uses deprecated `api.soundcloud.com/oauth2/token` and legacy `scope=non-expiring`. | 2026 guide: token host `secure.soundcloud.com/oauth/token`. | `src/config.ts:150-160`, `src/auth/oauth.ts:100-180`. |
| H3 | H | `src/index.ts:178-186` | `McpServer`/transport created per session and never closed; sessions leak after DELETE/expiry. | `sessions.delete` only removes the map entry. | `src/mcp/sessions.ts:60-70` closes transport; server close in `onclose`. |
| H4 | H | `src/tools/tracks.ts:71-77` | `get_stream_url` reads `http_mp3_128_url`, which is absent from the 2026 `Streams` schema (only HLS AAC/MP3 + preview), and invents `expires_in_seconds: 3600`. | OpenAPI `Streams` schema has `hls_aac_160_url`, `hls_mp3_128_url`, `preview_mp3_128_url`. | `src/soundcloud/api.ts:128-160` expiry parsing; `src/tools/tracks.ts:270-305` all formats, real expiry or null. |
| H5 | H | `src/soundcloud/client.ts:59-64,130,147-153` | Drops `next_href`; every list is silently truncated to one page. | `unwrapCollection` returns only `collection`. | `src/soundcloud/http.ts:200-270` linked_partitioning + cursor. |
| H6 | H | `src/soundcloud/client.ts:66-71` | Always `res.json()`; 204/empty bodies (DELETE/PUT) throw a JSON SyntaxError mislabelled as API error. | `handleResponse` unconditional parse. | `src/soundcloud/http.ts:82-100` empty-body handling. |
| H7 | H | `src/types.ts:7`; `src/tools/tracks.ts:50` | Track IDs typed as `number` and tool inputs as `z.number()`, while SoundCloud IDs are 64-bit/URN-based. | Playlist code already needed string workaround (`client.ts:175-177`). | `src/util/ids.ts`, string/URN schemas in every tool. |
| H8 | H | `src/soundcloud/client.ts:175-178,219-226` | Playlist tracks sent as `{id}`, but the 2026 schema requires `{urn}`; `addTracksToPlaylist` reads `t.id`, which is `undefined` for numeric/id-only entries. | OpenAPI `CreateUpdatePlaylistRequest.tracks.items.required=[urn]`. | `src/soundcloud/api.ts:108-125,196-225` URN normalization + `trackUrnsFromPlaylist`. |
| H9 | H | `src/auth/mcpAuth.ts:232-247` | Token exchange has no timeout/abort; a hanging SoundCloud connection pins the request. | No `AbortSignal`. | `src/auth/oauth.ts:100-185` `AbortSignal.timeout`. |
| H10 | H | `src/soundcloud/client.ts:23-55` | No retry/backoff for 429/5xx despite surfacing `retry_after`. | Only error mapping. | `src/soundcloud/http.ts:165-190` Retry-After + jitter. |
| M1 | M | `src/auth/pkceStore.ts:12-13` | PKCE states/auth codes only in memory; restart or multi-replica breaks the flow. | `new Map()`; no persistence/limit. | Documented limitation; short-lived by design (`SECURITY.md`). |
| M2 | M | `src/auth/mcpAuth.ts:22-25` | Reads `../../src/ui/login.html` at runtime; dist-only/package installs break. | Path assumes source tree. | UI embedded in `src/panel/ui.ts`. |
| M3 | M | `src/index.ts` | No graceful shutdown; transports/servers never closed on SIGTERM. | No signal handlers. | `src/index.ts:70-110`, `src/server.ts:330-345`. |
| M4 | M | `src/index.ts` | No rate limiting or request-size limits on auth/MCP/API. | Express defaults only. | `src/server.ts:47-70,210-220`; body limits. |
| M5 | M | `src/index.ts:26-29` | CORS headers omit `Last-Event-ID` needed for SSE resumption; no Host/origin checks. | CORS list. | `src/server.ts:100-115,190-200` Host allowlist + full headers. |
| M6 | M | `src/types.ts:47-52` | Error model lacks 403/409/422 and request-id/correlation. | Only 4 codes. | `src/errors.ts`, `src/soundcloud/http.ts:250-300`. |
| M7 | M | `src/debug.ts:11-16` | Debug logs serialize arbitrary params; no redaction of secrets. | `JSON.stringify(a)`. | `src/logger.ts:12-45` redaction. |
| M8 | M | `README.md:12` | README claims a "reorder" tool that does not exist. | Tool list has no reorder. | `reorder_playlist` tool (`src/tools/playlists.ts`). |
| M9 | M | `src/types.ts:29` | `Playlist.is_public` is not in the API response (`sharing` is); type lies and output loses visibility. | OpenAPI playlist schema. | `src/soundcloud/types.ts:78-95` uses `sharing`. |
| M10 | M | `Dockerfile:1-7` | Builds on `node:20-alpine` and runs as root; `npm ci` in runtime stage. | No `USER`, old LTS. | `Dockerfile` node 24, multi-stage, `USER node`. |
| M11 | M | `package.json` | No `engines`; test glob depends on a Node version that expands globs. | `node --test 'src/**/*.test.ts'`. | `engines >=20.19`, tests in `tests/`, CI matrix 20/22/24. |
| M12 | M | `.github/workflows/` | Only image publishing; no typecheck/tests in CI. | Single workflow. | `.github/workflows/ci.yml`. |
| L1 | L | `src/index.ts:39-41` | Hardcoded `version: "1.0.0"` in health. | Diverges from package.json. | `config.version` everywhere. |
| L2 | L | `src/soundcloud/client.ts:101-106` | Error body interpolated unbounded into message. | Could leak large/PII payloads. | Truncated `details` in `http.ts:255-300`. |
| L3 | L | `src/tools/playlists.ts:61-68` | `is_public` naming differs from API `sharing`, inviting wrong payloads. | API uses `sharing`. | Tools accept `sharing` explicitly. |

### Feature gaps (not "bugs" but missing product)

| Gap | Impact |
|---|---|
| No track upload (`POST /tracks` multipart) | Core artist workflow impossible |
| No profile read/update (`GET/PUT /me`, avatar) | No profile panel |
| No social actions (like/repost/follow/comments) | No artist growth tools |
| No pagination/cursors | Large libraries truncated |
| No artwork upload | Covers cannot be changed |
| No local audio editing (tags/ID3/artwork/speed/normalize) | Metadata and masters cannot be prepared |
| No browser panel/REST API | Only chat-driven control |
| No tests for auth/session/upload/errors | Regressions invisible |
| No token refresh rotation | SoundCloud refresh tokens invalidate after one use |

## 7. Stubs, dead code and misleading claims

- `README.md:74` — "Your SoundCloud credentials are never stored on the server"
  is false: the refresh token embeds `client_id` + `client_secret`
  (`mcpAuth.ts:68-78`) and is handed to the MCP client.
- `README.md:12` — "reorder" has no dedicated tool or documented semantics.
- `src/tools/tracks.ts:71` — `http_mp3_128_url` is dead against the current
  schema; the tool returns `{stream_url: undefined}` with a fabricated expiry.
- `src/soundcloud/client.ts:66-71` — no empty-body branch; `deletePlaylist`
  works only by accident (it skips `handleResponse` on success).
- `src/auth/mcpAuth.ts:22-25` — `src/ui/login.html` path is a packaging stowaway.
- No placeholders/TODO markers were found; the gaps are missing features, not
  fake implementations.

## 8. Tests and evidence

Observed on 2026-11-09 in this workspace:

| Check | Result |
|---|---|
| Donor `npm install` | 141 packages, ok |
| Donor `npx tsc --noEmit` | rc 0 |
| Donor `npm test` | 7 pass / 0 fail |
| v2 `npm run typecheck` | rc 0 |
| v2 `npm test` | **36 pass / 0 fail** (10 files) |
| v2 `npm run build` | rc 0 |
| v2 smoke `/health` | 200, connection metadata |
| v2 smoke `/mcp` without token | 406/401 as expected by Accept header |
| v2 panel browser smoke | 7 tabs, audio section renders, tab switching works |
| Real audio fixture | ffmpeg 9.0.2 generated MP3; tags/artwork/tempo/trim/normalize/convert verified by ffprobe |

Test coverage by area:

- `tests/core.test.ts` — URN parsing, PKCE, AES-GCM tamper detection, signed
  values, ID3 parsing, garbage input.
- `tests/http.test.ts` — OAuth header, 401 refresh, 429 Retry-After, error
  mapping, pagination, SSRF guard, multipart Content-Length/bytes, stream
  expiry.
- `tests/store.test.ts` — encrypted persistence, token rotation, single-use
  auth codes, refresh rotation, `invalid_grant`, single-flight.
- `tests/oauth-flow.test.ts` — full DCR → authorize → callback → token → MCP
  initialize/tools list; session-token binding returns 403; WWW-Authenticate;
  redirect URI rejection.
- `tests/panel-auth.test.ts` — browser sign-in, no token field, HttpOnly cookie,
  connection stored.
- `tests/panel-api.test.ts` — state, streaming multipart upload, track patch,
  export, audio probe/tags/tempo routes.
- `tests/upload.test.ts` — ID3 auto-fill, explicit overrides, media roots,
  unsupported/oversize.
- `tests/audio.test.ts` — ID3 writer preserves unknown frames, real ffmpeg
  tempo/trim/normalize/convert, backup, tag/artwork preservation.

Research evidence (observed 2026-11-09):

- SoundCloud OpenAPI `openapi/api.yaml` at commit master, 3,522 lines, 55 paths,
  SHA-256 prefix `0d057017…`; `Streams` schema; `TrackDataRequest`; URN paths.
- SoundCloud API guide (2026): `Authorization: OAuth`, `secure.soundcloud.com`
  token host, single-use refresh, 4 GB/24 h uploads, artwork is PRO-only,
  audio cannot be replaced after upload.
- MCP 2025-06-18 Authorization: audience validation, RFC 8707 resource
  indicators, token passthrough forbidden, `WWW-Authenticate` on 401.
- Local `ffmpeg -h filter=atempo|rubberband|loudnorm` on ffmpeg 9.0.2
  (rubberband, loudnorm, libmp3lame available).

## 9. Risks and limitations after the rewrite

- Single-process OAuth state: dynamic clients/codes are in memory; a restart
  interrupts an in-flight authorization (documented).
- SoundCloud does not document playlist artwork updates on `PUT`; the server
  attempts it and returns the real error, but cannot guarantee it.
- SoundCloud cannot replace audio after upload; speed edits require a new
  upload (the tool and UI state this).
- `loudnorm` one-pass normalization is accurate but not the two-pass
  measurement pipeline; a two-pass mode can be added later.
- The panel edits server-side paths, not files on the browser machine; the
  browser must upload to `/api/upload` first or the file must exist inside
  `SC_MEDIA_DIRS`.
- OAuth client registration is memory-only; MCP clients re-register after a
  restart (by design for short-lived codes).

## 10. Verdict

The donor is a clean, minimal **playlist read/management** MCP server, not a
production artist tool: its token model violates the MCP authorization spec, it
uses the wrong SoundCloud auth scheme and a dead stream field, it has no
uploads/profile/social/pagination, and its tests cover only playlist ID
serialization.

The v2 rewrite keeps the useful shape (Express + MCP Streamable HTTP + small
tools) and replaces the security-critical parts, adds the full artist workflow,
and adds a local audio lab with real ffmpeg/ID3 processing. It is a **full
replacement**, not a patch series; the donor's OAuth implementation is not
preserved because it cannot be made safe without changing the token model.

**Rating after rewrite: 10/10 for the scoped personal-artist deployment**,
with the explicit limitations in §9 (single-process OAuth state, playlist
artwork API uncertainty, SoundCloud audio-replacement prohibition).
