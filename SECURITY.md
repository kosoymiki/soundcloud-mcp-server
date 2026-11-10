# Security model

## Threat model

The server is designed for a personal device or a small self-hosted deployment
where the operator owns the SoundCloud account. It protects against:

- a browser-based attacker trying to obtain the operator's SoundCloud tokens;
- an MCP client or a malicious page trying to reuse another session's token;
- path traversal through upload parameters;
- token leakage through logs, URLs, or error messages;
- accidental plaintext storage of SoundCloud credentials.

It does **not** attempt to protect against a compromised host account, a
malicious root user, or a SoundCloud-side breach.

## Token handling

- **No token passthrough.** SoundCloud access tokens are stored server-side and
  are never accepted as MCP bearer tokens. MCP clients receive opaque,
  server-issued `scmcp_at_…` tokens. This follows the MCP 2025-06-18 rule that a
  resource server must not accept tokens issued for another audience.
- **Two token layers.** MCP access tokens (7 days by default) and MCP refresh
  tokens (30 days, single-use rotation) are stored as SHA-256 hashes. SoundCloud
  access tokens (~1 h) and refresh tokens (single-use) live only in the
  encrypted connection records.
- **Refresh rotation.** `TokenService` single-flights concurrent refreshes,
  persists the rotated SoundCloud refresh token *before* returning, and marks
  the connection `needsReauth` on `invalid_grant`. A 5xx refresh is retried once
  because SoundCloud can burn a refresh token while returning 5xx.
- **Encryption at rest.** `DATA_DIR/state.enc` is AES-256-GCM with a random IV
  and authentication tag; the key is `MCP_ENCRYPTION_KEY` or
  `DATA_DIR/encryption.key` (0600, generated). There is no plaintext credential
  file.
- **Browser sessions.** The panel cookie contains a server access token, is
  `HttpOnly`, `SameSite=Lax`, and `Secure` when `PUBLIC_URL` is HTTPS. Logout
  revokes the token server-side.
- **Exported web cookies.** `DATA_DIR/chrome-soundcloud-cookies.json` holds live
  SoundCloud web-session cookies (the same credential class as a browser
  profile). It is written `0600`, is ignored by `.gitignore`, and the exporter
  refuses to write inside any git work tree (`SC_ALLOW_COOKIES_IN_REPO=1` is the
  explicit override). Cookie values are never logged or returned by tools — only
  names, counts and token expiry are reported. Treat the file like a password:
  delete it when no longer needed.
- **Corrupt state is preserved, not overwritten.** If `state.enc` cannot be
  decrypted or parsed, it is renamed to `state.enc.corrupt-<timestamp>` before
  the server starts empty, so a failed migration never destroys credentials
  silently.

## OAuth server hardening

- Discovery: RFC 8414 authorization-server metadata and RFC 9728 protected
  resource metadata (both `/…` and `/…/mcp` paths).
- Dynamic client registration: redirect URIs must be `https:` or loopback
  `http:`; fragments and embedded credentials are rejected; authorized
  redirect URIs are stored per client and checked **exactly** at authorize time.
- PKCE S256 is mandatory; verifiers are 64 random bytes (86 base64url chars).
- Authorization codes are single-use, hashed at rest, bound to client,
  redirect URI and PKCE challenge, and expire after 2 minutes.
- The login form path (only used when app credentials are not in env) is
  protected by a signed flow value bound to a `SameSite=Lax` cookie, so a
  cross-site POST cannot start an authorization for another browser.
- `resource` (RFC 8707) is validated against `${PUBLIC_URL}/mcp` when supplied.
- Access tokens are never placed in URLs.

## Panel and API hardening

- CSRF: cookie or loopback auto-login mutations require `x-scmcp-csrf: 1` and,
  when an `Origin` header is present, an exact origin match. Bearer-token
  requests are not attachable by cross-site forms and skip the header check.
- Session binding: an MCP session records the hash of the token that created it;
  a different valid token receives 403.
- Upload paths are resolved with `realpath`, must stay inside `SC_MEDIA_DIRS`
  (or the server's own temp upload dir), and are checked for extension and size
  before any read.
- Multipart parsing uses `busboy` with `files: 1`, field-size and file-size
  limits; temp files are `0600` and deleted in `finally`.
- Request bodies are bounded: JSON 4 MB on `/mcp`, 256 KB on panel APIs,
  64 KB on OAuth endpoints; multipart is streamed to disk.
- Rate limits: 60 auth requests/min/IP and 600 API/MCP requests/min/IP.
- Host header validation on `/mcp` blocks DNS-rebinding origins.
- CSP with per-request nonces on the panel and login pages; no inline event
  handlers in generated HTML (the panel's script is nonce-bound).
- Errors are typed and truncated; tokens are never echoed.

## Audio lab hardening

- ffmpeg/ffprobe are spawned with an argument array (`spawn`, no shell), so
  file names and metadata cannot inject commands.
- Input audio and artwork must resolve inside `SC_MEDIA_DIRS`; output must
  resolve inside `SC_MEDIA_DIRS` or `AUDIO_WORK_DIR`.
- Overwrite is opt-in (`overwrite=true`); otherwise an existing output path is
  rejected with `CONFLICT`. In-place ID3 edits write a `.bak` copy first and use
  a temp file + rename.
- ID3 editing streams the audio payload and preserves unknown frames; only the
  requested text/APIC frames change.
- Artwork is capped at 20 MB; concurrent ffmpeg jobs are bounded by
  `AUDIO_MAX_CONCURRENT` (default 2).
- Playlist artwork is attempted only through a documented multipart request;
  a rejection is returned as a typed error rather than silently ignored.

## Logging

`Logger` redacts `access_token=…`, `refresh_token=…`, `client_secret=…`,
`code_verifier=…`, `Authorization: OAuth|Bearer …`, `cookie:`/`set-cookie:`
values, SoundCloud `oauth_token`/`sc_session`/`datadome` values, decoded tokens
(`scmcp_at_…`/`scmcp_rt_…`) and matching JSON fields. Debug logs contain
method/path/status/latency, not bodies of token exchanges.

## Deployment guidance

- **One process per `DATA_DIR`.** State is written atomically (temp + rename)
  but there is no cross-process lock; two servers sharing a data dir would
  last-writer-win and could lose rotated refresh tokens.

- Keep the default `HOST=127.0.0.1` unless you put the server behind a TLS
  reverse proxy.
- Use HTTPS in `PUBLIC_URL` for any non-loopback deployment; the panel cookie
  becomes `Secure` automatically.
- Register only the exact callback URI in the SoundCloud app.
- Run as an unprivileged user (the container uses `node`); keep `DATA_DIR`
  `0700`.
- Back up `DATA_DIR` if you care about the encrypted connection and tokens; the
  key file is required to decrypt it.
- Rotate `MCP_LOCAL_TOKEN` and `MCP_ENCRYPTION_KEY` if either may have leaked;
  rotating the encryption key invalidates stored tokens and connections.

## Known limitations

- Dynamic clients and OAuth authorization codes are in-memory; a restart
  requires clients to re-register and in-flight codes to be restarted. This is
  deliberate: codes are short-lived and persisting them increases risk.
- The server is single-process; sessions and rate limits are not shared across
  replicas.
- Artwork upload is a PRO-only SoundCloud feature; the failure is surfaced as a
  warning, not hidden.
- SoundCloud API behavior can change; the integration follows the public
  OpenAPI description and the API guide as of 2026-11-09.

## Reporting

Open a private security advisory or contact the maintainer directly. Do not
include real access tokens, refresh tokens, or client secrets in a report.
