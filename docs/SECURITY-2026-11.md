# MCP operational & security compliance — November 2026

Scope: `soundcloud-mcp-server` 2.2.x against the MCP **2026-07-28** specification
and the Security Best Practices guide (accessed 2026-11-10 via stealth-browser:
`https://modelcontextprotocol.io/specification/2026-07-28/basic/security_best_practices`,
canonical `/docs/2026-07-28/tutorials/security/security_best_practices`).

Legend: **pass** = implemented and tested; **partial** = implemented with a
documented limitation; **gap** = not implemented (tracked).

## Security Best Practices checklist

| Control (spec) | Status | Evidence / notes |
|---|---|---|
| No token passthrough; audience-bound server tokens | pass | Server issues opaque `scmcp_at_…`; SoundCloud tokens never leave `DATA_DIR` (`src/auth/store.ts`, `src/http/auth.ts`). |
| Confused deputy: per-client consent before third-party auth | pass | `/oauth/authorize` renders a consent page with client name, redirect URI and scopes; `decision=allow` is mandatory; denial returns `access_denied` (`src/auth/oauth.ts:66-140,440-460`). Tested in `tests/oauth-flow.test.ts`. |
| Consent page CSRF protection | pass | Signed flow value plus `scmcp_flow` cookie binding; PKCE S256; single-use state (`src/auth/oauth.ts`, `src/auth/crypto.ts`). |
| Token/session hijacking: bind MCP session to its token | pass | `McpSessionManager.tokenMatches` + 403 on mismatch (`src/server.ts`, `tests/oauth-flow.test.ts`). |
| State handle hijacking: one-time, expiring handles | pass | `takeLoginState` / `consumeAuthCode` are single-use TTL entries (`src/auth/store.ts`). |
| SSRF: outbound hosts allowlisted | pass | `HttpClient.buildUrl` accepts only `api.soundcloud.com` + configured base, refuses https→http downgrade (`src/soundcloud/http.ts`). |
| SSRF against authorization servers | pass | `SC_AUTH_BASE`/`SC_API_BASE` are operator config, validated as URLs; no user-controlled token endpoint. |
| Local MCP server compromise: loopback binding + host checks | pass | `HOST=127.0.0.1` default; Host header validated for `/mcp*`, `/panel*`, `/api/*`, OAuth paths (`src/server.ts:195-213`). |
| OAuth authorization URL validation | pass | `client_id` must be registered, `redirect_uri` exact match, `state` required, `code_challenge` length/format checked, `resource` limited to `/mcp` and `/mcp-v2` (`src/auth/oauth.ts`). |
| Localhost redirect URI impersonation | pass | HTTPS, or HTTP only for `localhost`/`127.0.0.1`/`::1`; exact registered match (`validateRedirectUri`). |
| Scope minimization | partial | SoundCloud does not expose fine-grained MCP scopes; `scopes_supported` is empty and the consent page states the account-level access. Documented, not silently widened. |
| Dynamic client registration safety | pass | Per-client UUID, redirect validation, 60/min auth rate limit, 1000-client cap, 30-day TTL (`src/auth/store.ts`). |
| DNS rebinding (web origin) | pass | Host check + CORS allowlist (public origin + localhost) + CSRF header on cookie/loopback mutations (`src/server.ts`, `src/panel/api.ts`). |
| Rate limiting | pass | 600/min MCP, 60/min auth; per-IP buckets (`src/server.ts`). |
| Body limits | pass | 4 MiB on both MCP transports; 256 KiB panel JSON; busboy file cap (`src/server.ts`, `src/panel/api.ts`). |
| Structured, redacted logs | pass | JSON lines, redacts tokens/cookies/`scmcp_*` (`src/logger.ts`, `tests/hardening.test.ts`). |
| Secret storage | pass | AES-256-GCM `state.enc` (0600), 0700 dirs, exported cookies outside git with a write guard. |
| Graceful shutdown | pass | SIGINT/SIGTERM, session close, 5 s force-exit (`src/index.ts`). |
| Health/metrics | partial | `/health` exposes status/counts only; no Prometheus endpoint (deliberate: personal server). |

## MCP 2026-07-28 surface

| Requirement | Status |
|---|---|
| Modern transport `/mcp-v2` with `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, `_meta` envelope | pass (`src/mcp/modern.ts`, `tests/modern.test.ts`) |
| Tools/resources/prompts parity across eras | pass (55 tools, `soundcloud://guide`, `plan_upload`) |
| Tool safety annotations (`readOnlyHint`, `destructiveHint`, …) | pass (per-tool annotations) |
| Legacy 2025-11-25 compatibility | pass (`/mcp`) |
| Pagination | pass (`tools/list` 50/page with `nextCursor`) |

## Operational quality

| Area | Status | Notes |
|---|---|---|
| Reproducible install | pass | `install-termux.sh` (+ `--dry-run`), Dockerfile with Chromium/ffmpeg, compose |
| Tests | pass | 81 unit/journey + mock E2E 16 checks, run in CI |
| CI | pass | Node 24, per-file bounded runs, optional ffmpeg, Docker build |
| Failure behavior | pass | typed errors, corrupt state preserved, partial outputs removed |
| Multi-instance | partial | documented single process per `DATA_DIR` (no cross-process lock) |

## Tracked gaps (not security regressions)

1. Scope minimization is limited by SoundCloud's account-level OAuth scopes.
2. No Prometheus metrics endpoint (health counters only).
3. No cross-process lock for a shared `DATA_DIR`.
4. Docker image build is exercised in CI but its runtime tools (Chromium/ffmpeg)
   are not smoke-tested inside the container.
