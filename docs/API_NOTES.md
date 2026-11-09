# API research notes — SoundCloud, MCP and audio

Access date for all web sources: **2026-11-09**. Labels: **observed** (primary
source fetched), **inferred** (derived, not directly stated), **unknown** (not
verified; not implemented as if true).

## Sources

| ID | Source | Method | Used for |
|---|---|---|---|
| S1 | `https://raw.githubusercontent.com/soundcloud/api/master/openapi/api.yaml` | HTTPS fetch; 3,522 lines; SHA-256 prefix `0d057017b4057642a5f622efe97df384` | endpoints, schemas, URNs, upload fields, streams |
| S2 | `https://developers.soundcloud.com/docs/api/explorer/api.json` | HTTPS fetch; 85,188 bytes | resolved parameters, auth flows |
| S3 | `https://developers.soundcloud.com/docs/api/guide` | rendered text (search integration) | auth scheme, token host, uploads, limits |
| S4 | `https://developers.soundcloud.com/docs/llm-context` | rendered text | key facts, single-use refresh, 4 GB/24 h |
| S5 | `https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization` | stealth-browser DOM text | audience validation, no passthrough, WWW-Authenticate |
| S6 | `ffmpeg -h filter=atempo`, `-h filter=rubberband`, `-h filter=loudnorm` on ffmpeg 9.0.2 | local binary | filter ranges/options |
| S7 | `https://raw.githubusercontent.com/Zazama/node-id3/master/README.md` | stealth-browser text | ID3 frame/APIC reference |
| S8 | `https://id3.org/id3v2.4.0-structure` | stealth-browser (page renders empty in headless Chromium; title only observed) | ID3v2.4 reference URL only; structure implemented from the published frame layout |

## Authentication (observed)

- Authorization host: `https://secure.soundcloud.com`; authorize endpoint
  `/authorize`; token/refresh endpoint `/oauth/token` (S1, S2, S3).
- Header on API calls: `Authorization: OAuth <access_token>` (S1 `AuthHeader`,
  S3). `Bearer` is accepted for compatibility by some endpoints but is not the
  documented scheme; v2 defaults to `OAuth` and allows `Bearer` via
  `SC_AUTH_SCHEME`.
- Authorization Code + PKCE S256; token response contains `access_token`,
  `refresh_token`, `expires_in`, `scope` (S3).
- Access tokens ~1 hour; refresh tokens are **single-use** (S3, S4).
- Client Credentials tokens only for public resources and only with HTTP Basic
  client authentication (S3); not implemented because the server always acts on
  a user's behalf.
- The legacy `https://api.soundcloud.com/oauth2/token` endpoint is deprecated;
  the donor used it (H2 in the review).

## Upload — `POST /tracks` (observed, S1/S2/S3)

`multipart/form-data` with `track[title]` and `track[asset_data]` required.
Supported fields:

| Field | Notes |
|---|---|
| `track[title]` | required |
| `track[asset_data]` | binary, required |
| `track[artist]` | becomes `metadata_artist` in responses; do **not** send `track[metadata_artist]` on upload |
| `track[description]`, `track[genre]`, `track[tag_list]` | `tag_list` space-separated, multiword tags quoted |
| `track[permalink]`, `track[sharing]` (`public`/`private`) | |
| `track[embeddable_by]` (`all`/`me`/`none`) | |
| `track[purchase_url]`, `track[purchase_title]` | |
| `track[label_name]`, `track[release]`, `track[release_date]` (`yyyy-mm-dd`) | |
| `track[isrc]`, `track[license]` (8 enum values) | |
| `track[streamable]`, `track[downloadable]`, `track[commentable]` | booleans |
| `track[reveal_stats]`, `track[reveal_comments]` | booleans |
| `track[artwork_data]` | binary, **PRO users only** |

Limits (S3/S4): up to **4 GB** per file, **24 hours** of audio per track.
Formats include AIFF, WAVE, FLAC, OGG, MP2, MP3, AAC, AMR, WMA. Audio is
transcoded asynchronously after `201`; the uploaded file cannot be replaced.

**Not implemented:** a chunked upload endpoint does not appear in the public
OpenAPI. The server uses a single streamed multipart request with an exact
`Content-Length` and bounded 5xx/401 retries that rebuild the body. Chunked
upload is therefore `unknown`, not invented.

## Update track — `PUT /tracks/{track_urn}` (observed)

- JSON body `{ "track": { ... } }` for metadata; `metadata_artist` is used in
  JSON updates (not `track[artist]`).
- Multipart `PUT` supports `track[artwork_data]` for artwork replacement.
- The audio payload cannot be updated (S3): speed/audio edits must be uploaded
  as a new track.

## Playlists / albums — `/playlists` (observed)

- Create/update body `{ "playlist": { ... } }` with `title`, `description`,
  `sharing`, `tracks:[{urn}]`, `genre`, `tag_list`, `label_name`, `license`,
  `permalink`, `purchase_url`, `purchase_title`, `release_date`, `set_type`
  (`album`/`playlist`), `ean`.
- `artwork_data` is documented **only for POST** (`CreateUpdatePlaylistRequest`,
  property description "Only for POST"). Playlist artwork update on `PUT` is
  therefore **unknown**; v2 attempts the multipart PUT and returns the real
  SoundCloud error if rejected. Track artwork is documented on `PUT /tracks`.
- Track references in playlists use `{ "urn": "soundcloud:tracks:…" }`; the
  donor's `{id}` form is legacy.

## Identifiers and pagination (observed)

- Path parameters are `*_urn`: `soundcloud:tracks:308946187`,
  `soundcloud:playlists:1212781357`, `soundcloud:users:948745750`,
  `soundcloud:system-playlists:track-stations:…`. Numeric ids are marked
  deprecated in the 2026 spec.
- List endpoints support `linked_partitioning=1` and return
  `{collection, next_href}`. `offset` is deprecated. `limit` is per page.
- `access` filters tracks by `playable|preview|blocked`.

## Streams (observed)

`GET /tracks/{track_urn}/streams` returns only:

```json
{
  "hls_aac_160_url": "…",
  "hls_mp3_128_url": "…",
  "preview_mp3_128_url": "…"
}
```

`http_mp3_128_url` is **not** in the 2026 schema. The donor's stream tool reads
that field and hardcodes `expires_in_seconds: 3600`. v2 returns all formats,
the track `access` state, and derives expiry from `Policy`, `Expires` or
`X-Amz-Date`/`X-Amz-Expires` when present; otherwise `null` (not fabricated).

## Profile (partially observed)

- `GET /me` (observed) returns identity, counts, plan, `quota`,
  `upload_seconds_left`, private counts.
- `PUT /me` is **not** in the public OpenAPI. It is documented by older
  SoundCloud material and the official `soundcloud-python` examples
  (`client.put("/me", user={"description": ...})`), and RapidAPI wrappers expose
  it. v2 implements `PUT /me` with `{user:{...}}` as **reported-unverified**
  against the current API; failures are surfaced as the real HTTP error.
- Avatar: `PUT /me` multipart `user[avatar_data]` (historical docs, same
  status).
- Upload quota: `quota.upload_seconds_left` and top-level
  `upload_seconds_left` (observed in the `Me` schema).

## MCP authorization (observed, S5)

- HTTP transport servers act as OAuth 2.1 resource servers; they must validate
  the token audience (RFC 8707) and must not accept tokens issued for another
  service. Token passthrough is explicitly forbidden.
- A 401 must carry `WWW-Authenticate`; protected-resource metadata is RFC 9728.
- Authorization-server metadata is RFC 8414; dynamic registration is RFC 7591.
- Redirect URIs must be HTTPS or loopback; PKCE S256 is required by the
  SoundCloud leg and used for the MCP leg.
- v2 issues its own opaque tokens, validates them server-side, and binds MCP
  sessions to the token hash. SoundCloud tokens never leave the server.

## Audio editing facts (observed, S6)

Local ffmpeg 9.0.2 build:

| Filter | Range / options | v2 use |
|---|---|---|
| `atempo` | tempo 0.5–100 | fallback tempo, chained for old builds |
| `rubberband` | tempo/pitch 0.01–100, `formant`, `pitchq`, `transients` | preferred tempo/pitch |
| `asetrate` + `aresample` | arbitrary sample-rate factor | tape speed / pitch fallback |
| `loudnorm` | `I` −70…−5, `LRA` 1…50, `TP` −9…0 | EBU R128 normalization |
| `libmp3lame` | MP3 encoder | 64–320 kbps output |
| `atrim` + `asetpts` | start/end | trim |

The v2 UI/tool caps ratio at 0.25–4.0 for musical quality even though
`rubberband` would accept more.

## ID3 writing (observed layout, S7/S8)

- ID3v2.4 header: `ID3`, version `04 00`, flags, 4-byte syncsafe size
  (excluding header, including padding).
- Frame: 4-char ID, 4-byte syncsafe size, 2 flag bytes, payload.
- Text frames: encoding byte (3 = UTF-8) + UTF-8 text.
- APIC: encoding, MIME (latin1, NUL), picture type, description (encoding, NUL),
  binary image.
- Frames used: `TIT2` title, `TPE1` artist, `TALB` album, `TPE2` album artist,
  `TCON` genre, `TDRC` year/date, `TRCK` track, `TPOS` disc, `TCOM` composer,
  `TBPM` BPM, `TSRC` ISRC, `TCOP` copyright, `TPUB` publisher, `TENC`
  encoded-by, `COMM` comment, `USLT` lyrics, `APIC` artwork, `TXXX:ISRC`.
- The writer preserves unknown frames and writes a 2 KB padding area; the reader
  handles v2.2/2.3/2.4, tag/frame unsynchronisation and extended headers, and
  skips compressed/encrypted frames with a warning.

## App registration eligibility (observed 2026-11-09)

The official CLI (`soundcloud/api/scripts/sc-api-auth.mjs`) authenticates
successfully but `POST /me/apps` returns:

> `Application registration is not available for your account.`

SoundCloud's official answer in `soundcloud/api` issue **#612** (comment by
`dpreussler`, **2026-11-02**):

> "The API registration is now available exclusively through Artist Pro
> subscriptions."

Consequences:

- `/you/apps` may be empty and the CLI cannot create an app on a non-Artist-Pro
  account; this is an account/policy gate, not an OAuth bug.
- To obtain `client_id`/`client_secret` the account needs Artist Pro, or the
  operator must supply credentials from an existing app.
- Our server correctly surfaces the CLI error and never fabricates credentials.

## Things intentionally not implemented (unknown / out of scope)

- Chunked upload endpoint (not in the public spec).
- Scheduled release / private scheduling (not in the track upload schema).
- Playlist artwork update beyond the multipart attempt.
- Replacing audio of an existing track (explicitly impossible).
- SoundCloud password/user-credentials OAuth (deprecated; not used).
- Captcha/paywall/auth bypass of any kind.
