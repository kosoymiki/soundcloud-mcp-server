/*
 * Copyright (C) 2026 Marcell Kehmstedt
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { randomUUID } from "node:crypto";
import express, { type Request, type Response, type Router } from "express";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { Store } from "./store.js";
import type { TokenService } from "./tokenService.js";
import { pkcePair, randomToken, signValue, verifyPkce, verifySignedValue, timingSafeEqualString } from "./crypto.js";
import { AppError } from "../errors.js";
import { sleep } from "../util/async.js";
import { panelCookie } from "../http/cookies.js";
import { resolveAppCredentials } from "./appCredentials.js";

interface FlowPayload {
  exp: number;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  resource?: string;
}

const FLOW_COOKIE = "scmcp_flow";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.replace(/^::ffff:/, "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized.startsWith("127.");
}

export function validateRedirectUri(uri: string): { ok: true } | { ok: false; reason: string } {
  if (uri.length > 2000) return { ok: false, reason: "redirect_uri is too long" };
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return { ok: false, reason: "redirect_uri is not a valid URL" };
  }
  if (parsed.hash) return { ok: false, reason: "redirect_uri must not contain a fragment" };
  if (parsed.username || parsed.password) return { ok: false, reason: "redirect_uri must not embed credentials" };
  if (parsed.protocol === "https:") return { ok: true };
  if (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname)) return { ok: true };
  return { ok: false, reason: "redirect_uri must use https, or http on localhost/127.0.0.1" };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cookieOptions(config: Config): string {
  const secure = config.publicUrl.startsWith("https://") ? "; Secure" : "";
  return `Path=/; HttpOnly; SameSite=Lax${secure}`;
}

function renderLoginPage(config: Config, params: Record<string, string>, error?: string): string {
  const fields = Object.entries(params)
    .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}" />`)
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Connect SoundCloud</title>
<style>
  :root { --accent: ${config.brandColor}; color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: radial-gradient(1200px 600px at 50% -10%, #1d1d1d, #080808 60%);
         font: 15px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #eee; padding: 24px; }
  .card { width: min(440px, 100%); background: #141414; border: 1px solid #2a2a2a;
          border-radius: 16px; padding: 28px; box-shadow: 0 24px 80px rgba(0,0,0,.55); }
  h1 { font-size: 20px; margin: 0 0 6px; }
  p { margin: 0 0 18px; color: #9a9a9a; font-size: 13px; }
  label { display: block; font-size: 12px; text-transform: uppercase; letter-spacing: .06em;
          color: #8a8a8a; margin: 16px 0 6px; }
  input[type=text], input[type=password] { width: 100%; padding: 11px 12px; border-radius: 10px;
          border: 1px solid #333; background: #0d0d0d; color: #f2f2f2; font-size: 14px; }
  input:focus { outline: 2px solid color-mix(in srgb, var(--accent) 65%, transparent); border-color: transparent; }
  button { width: 100%; margin-top: 22px; padding: 12px; border: 0; border-radius: 10px;
           background: var(--accent); color: #fff; font-weight: 700; font-size: 15px; cursor: pointer; }
  button:hover { filter: brightness(1.08); }
  .error { background: #3a1111; border: 1px solid #6b2020; color: #ffb4b4; padding: 10px 12px;
           border-radius: 10px; font-size: 13px; margin-bottom: 16px; }
  .hint { margin-top: 16px; font-size: 12px; color: #777; }
  a { color: var(--accent); }
  code { background: #222; padding: 1px 5px; border-radius: 5px; }
</style></head>
<body><main class="card">
  <h1>Connect SoundCloud</h1>
  <p>This MCP server needs your SoundCloud application credentials to obtain a user token.
     They are stored encrypted on this server and never sent to the MCP client.</p>
  ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
  <form method="post" action="/oauth/authorize">
    ${fields}
    <label for="sc_client_id">SoundCloud client ID</label>
    <input id="sc_client_id" name="sc_client_id" type="text" autocomplete="off" required
           value="${escapeHtml(config.sc.clientId ?? "")}" />
    <label for="sc_client_secret">SoundCloud client secret</label>
    <input id="sc_client_secret" name="sc_client_secret" type="password" autocomplete="off" required />
    <button type="submit">Continue to SoundCloud</button>
  </form>
  <div class="hint">Create an app at <a href="https://soundcloud.com/you/apps" rel="noreferrer">soundcloud.com/you/apps</a>
    and register <code>${escapeHtml(config.sc.redirectUri)}</code>.</div>
</main></body></html>`;
}

async function exchangeSoundCloudCode(
  config: Config,
  params: { code: string; clientId: string; clientSecret: string; redirectUri: string; codeVerifier: string }
): Promise<{ accessToken: string; refreshToken?: string; expiresIn: number; scope?: string }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: params.clientId,
    client_secret: params.clientSecret,
    redirect_uri: params.redirectUri,
    code: params.code,
    code_verifier: params.codeVerifier,
  });

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await sleep(750);
    const response = await fetch(config.sc.tokenUrl, {
      method: "POST",
      headers: {
        accept: "application/json; charset=utf-8",
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
      signal: AbortSignal.timeout(config.sc.timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) {
      lastError = new AppError("API_ERROR", `SoundCloud token exchange failed (HTTP ${response.status}).`, {
        status: 502,
        details: text.slice(0, 500),
      });
      if (response.status >= 500) continue;
      throw lastError;
    }
    let parsed: {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_in?: unknown;
      scope?: unknown;
    };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new AppError("INVALID_RESPONSE", "SoundCloud token exchange returned invalid JSON.", {
        status: 502,
      });
    }
    if (typeof parsed.access_token !== "string") {
      throw new AppError("INVALID_RESPONSE", "SoundCloud token exchange returned no access_token.", {
        status: 502,
      });
    }
    return {
      accessToken: parsed.access_token,
      ...(typeof parsed.refresh_token === "string" ? { refreshToken: parsed.refresh_token } : {}),
      expiresIn: typeof parsed.expires_in === "number" ? parsed.expires_in : 3600,
      ...(typeof parsed.scope === "string" ? { scope: parsed.scope } : {}),
    };
  }
  throw lastError instanceof Error
    ? lastError
    : new AppError("API_ERROR", "SoundCloud token exchange failed.", { status: 502 });
}

export interface OAuthRouterDeps {
  config: Config;
  store: Store;
  tokens: TokenService;
  logger: Logger;
}

/**
 * Starts the SoundCloud authorization leg. Shared by the MCP authorize page and
 * the zero-form path where SC_CLIENT_ID/SC_CLIENT_SECRET are provided by the
 * environment (personal device setup: no secret ever typed in a browser).
 */
function redirectToSoundCloud(
  config: Config,
  store: Store,
  logger: Logger,
  res: Response,
  payload: FlowPayload,
  credentials: { clientId: string; clientSecret: string }
): void {
  const pkce = pkcePair();
  const state = randomToken(24);
  store.storeLoginState(state, {
    kind: "mcp",
    clientId: payload.clientId,
    redirectUri: payload.redirectUri,
    clientState: payload.state,
    codeChallenge: payload.codeChallenge,
    scClientId: credentials.clientId,
    scClientSecret: credentials.clientSecret,
    codeVerifier: pkce.verifier,
    ...(payload.resource ? { resource: payload.resource } : {}),
  });

  const params = new URLSearchParams({
    client_id: credentials.clientId,
    redirect_uri: config.sc.redirectUri,
    response_type: "code",
    state,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
  });
  const scope = process.env.SC_SCOPE?.trim();
  if (scope) params.set("scope", scope);

  logger.info("Starting SoundCloud authorization", { client: payload.clientId });
  res.setHeader("Set-Cookie", `${FLOW_COOKIE}=; ${cookieOptions(config)}; Max-Age=0`);
  res.redirect(`${config.sc.authorizeUrl}?${params.toString()}`);
}

export function createOAuthRouter(deps: OAuthRouterDeps): Router {
  const { config, store, logger } = deps;
  const router = express.Router();
  router.use(express.urlencoded({ extended: false, limit: "64kb" }));
  router.use(express.json({ limit: "64kb" }));

  const resource = `${config.publicUrl}/mcp`;

  router.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.set("Cache-Control", "no-store").json({
      issuer: config.publicUrl,
      authorization_endpoint: `${config.publicUrl}/oauth/authorize`,
      token_endpoint: `${config.publicUrl}/oauth/token`,
      registration_endpoint: `${config.publicUrl}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [],
      resource_indicators_supported: true,
    });
  });

  const protectedResource = {
    resource,
    authorization_servers: [config.publicUrl],
    bearer_methods_supported: ["header"],
    scopes_supported: [],
    resource_documentation: `${config.publicUrl}/panel`,
  };
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    router.get(path, (_req, res) => {
      res.set("Cache-Control", "no-store").json(protectedResource);
    });
  }

  router.post("/register", (req, res) => {
    const body = (req.body ?? {}) as { redirect_uris?: unknown; client_name?: unknown };
    if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) {
      res.status(400).json({ error: "invalid_client_metadata", error_description: "redirect_uris required" });
      return;
    }
    const redirectUris: string[] = [];
    for (const candidate of body.redirect_uris) {
      if (typeof candidate !== "string") {
        res.status(400).json({ error: "invalid_redirect_uri", error_description: "redirect_uris must be strings" });
        return;
      }
      const validation = validateRedirectUri(candidate);
      if (!validation.ok) {
        res.status(400).json({ error: "invalid_redirect_uri", error_description: validation.reason });
        return;
      }
      redirectUris.push(candidate);
    }
    const client = store.registerClient({
      clientId: randomUUID(),
      clientName: typeof body.client_name === "string" ? body.client_name.slice(0, 200) : "MCP client",
      redirectUris,
    });
    res.status(201).json({
      client_id: client.clientId,
      client_id_issued_at: Math.floor(client.createdAt / 1000),
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });

  router.get("/oauth/authorize", (req, res) => {
    const query = req.query as Record<string, string | undefined>;
    const responseType = query.response_type;
    const clientId = query.client_id;
    const redirectUri = query.redirect_uri;
    const state = query.state;
    const codeChallenge = query.code_challenge;
    const method = query.code_challenge_method ?? "S256";
    const requestedResource = query.resource;

    if (responseType !== "code" || !clientId || !redirectUri || !state || !codeChallenge) {
      res.status(400).type("text/plain").send("Invalid authorization request: response_type=code, client_id, redirect_uri, state and code_challenge are required.");
      return;
    }
    if (method !== "S256") {
      res.status(400).type("text/plain").send("Only S256 code_challenge_method is supported.");
      return;
    }
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) {
      res.status(400).type("text/plain").send("code_challenge must be 43-128 base64url characters.");
      return;
    }
    if (requestedResource && requestedResource !== resource) {
      res.status(400).type("text/plain").send(`resource must be ${resource}`);
      return;
    }
    const client = store.getClient(clientId);
    if (!client) {
      res.status(400).type("text/plain").send("Unknown client_id. Register the client first (RFC 7591).");
      return;
    }
    if (!client.redirectUris.includes(redirectUri)) {
      res.status(400).type("text/plain").send("redirect_uri does not exactly match a registered redirect URI.");
      return;
    }

    const flowPayload: FlowPayload = {
      exp: Date.now() + 9 * 60_000,
      clientId,
      redirectUri,
      state,
      codeChallenge,
      ...(requestedResource ? { resource: requestedResource } : {}),
    };

    // Personal-device setup: credentials come from env or the encrypted store,
    // so skip the form and send the browser straight to SoundCloud.
    const appCredentials = resolveAppCredentials(config, store);
    if (appCredentials) {
      redirectToSoundCloud(config, store, logger, res, flowPayload, appCredentials);
      return;
    }

    const flow = signValue(JSON.stringify(flowPayload satisfies FlowPayload), config.security.encryptionKey);

    res.setHeader("Set-Cookie", `${FLOW_COOKIE}=${flow}; ${cookieOptions(config)}; Max-Age=600`);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
    );
    res.send(
      renderLoginPage(config, {
        flow,
      })
    );
  });

  router.post("/oauth/authorize", (req, res) => {
    const body = req.body as Record<string, string | undefined>;
    const flow = body.flow;
    if (!flow) {
      res.status(400).type("text/plain").send("Missing authorization flow.");
      return;
    }

    const cookieHeader = req.headers.cookie ?? "";
    const cookieFlow = cookieHeader
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${FLOW_COOKIE}=`))
      ?.slice(FLOW_COOKIE.length + 1);
    if (!cookieFlow || !timingSafeEqualString(cookieFlow, flow)) {
      res.status(400).type("text/plain").send("Authorization flow does not match this browser session.");
      return;
    }

    const verified = verifySignedValue(flow, config.security.encryptionKey);
    if (!verified) {
      res.status(400).type("text/plain").send("Authorization flow expired. Start again.");
      return;
    }
    const payload = JSON.parse(
      Buffer.from(verified.payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
    ) as FlowPayload;

    const client = store.getClient(payload.clientId);
    if (!client || !client.redirectUris.includes(payload.redirectUri)) {
      res.status(400).type("text/plain").send("Client registration expired. Start again.");
      return;
    }

    const scClientId = body.sc_client_id?.trim() || config.sc.clientId || store.getAppCredentials()?.clientId;
    const scClientSecret =
      body.sc_client_secret?.trim() || config.sc.clientSecret || store.getAppCredentials()?.clientSecret;
    if (!scClientId || !scClientSecret) {
      res.status(400).type("text/plain").send("SoundCloud client id and secret are required.");
      return;
    }

    redirectToSoundCloud(config, store, logger, res, payload, {
      clientId: scClientId,
      clientSecret: scClientSecret,
    });
  });

  router.get("/soundcloud/callback", async (req, res) => {
    const query = req.query as Record<string, string | undefined>;
    if (query.error) {
      res.status(400).type("text/plain").send(`SoundCloud authorization error: ${escapeHtml(query.error)}`);
      return;
    }
    if (!query.code || !query.state) {
      res.status(400).type("text/plain").send("Missing code or state.");
      return;
    }
    const login = store.takeLoginState(query.state);
    if (!login) {
      res.status(400).type("text/plain").send("Authorization session expired. Start again.");
      return;
    }

    try {
      const tokens = await exchangeSoundCloudCode(config, {
        code: query.code,
        clientId: login.scClientId,
        clientSecret: login.scClientSecret,
        redirectUri: config.sc.redirectUri,
        codeVerifier: login.codeVerifier,
      });

      const connectionId = randomUUID();
      store.upsertConnection({
        id: connectionId,
        label: "oauth",
        scAccessToken: tokens.accessToken,
        ...(tokens.refreshToken ? { scRefreshToken: tokens.refreshToken } : {}),
        scClientId: login.scClientId,
        scClientSecret: login.scClientSecret,
        scExpiresAt: Date.now() + tokens.expiresIn * 1000,
        ...(tokens.scope ? { scopes: tokens.scope } : {}),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const code = store.storeAuthCode({
        connectionId,
        clientId: login.clientId ?? "panel",
        redirectUri: login.redirectUri ?? `${config.publicUrl}/panel`,
        codeChallenge: login.codeChallenge ?? "",
        scope: "",
        expiresAt: Date.now() + 2 * 60_000,
      });

      if (login.kind === "panel") {
        // Browser panel flow: issue a server access token and put it in an
        // HttpOnly cookie. No token is ever shown or copied by the user.
        const access = store.issueAccessToken(connectionId, "panel");
        res.setHeader(
          "Set-Cookie",
          panelCookie(config, access.token, Math.floor(config.security.accessTokenTtlMs / 1000), req.secure)
        );
        logger.info("Panel signed in via browser OAuth", { connection: connectionId });
        res.redirect(`${config.publicUrl}/panel`);
        return;
      }

      if (!login.clientId || !login.redirectUri || !login.clientState || !login.codeChallenge) {
        res.status(500).type("text/plain").send("Authorization state is incomplete. Start again.");
        return;
      }

      const redirect = new URL(login.redirectUri);
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("state", login.clientState);
      logger.info("SoundCloud account connected", { connection: connectionId });
      res.redirect(redirect.toString());
    } catch (error) {
      logger.error("SoundCloud callback failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (login.kind === "panel") {
        res.redirect("/panel/login?error=exchange_failed");
        return;
      }
      res.status(502).type("text/plain").send("Failed to obtain a SoundCloud token. Check server logs and retry.");
    }
  });

  router.post("/oauth/token", (req, res) => {
    const body = req.body as Record<string, string | undefined>;
    const grantType = body.grant_type;

    const oauthError = (status: number, code: string, description: string): void => {
      res.set("Cache-Control", "no-store").status(status).json({ error: code, error_description: description });
    };

    if (grantType === "authorization_code") {
      const code = body.code;
      const clientId = body.client_id;
      const redirectUri = body.redirect_uri;
      const verifier = body.code_verifier;
      if (!code || !redirectUri || !verifier) {
        oauthError(400, "invalid_request", "code, redirect_uri and code_verifier are required");
        return;
      }
      const record = store.consumeAuthCode(code);
      if (!record) {
        oauthError(400, "invalid_grant", "authorization code is invalid or expired");
        return;
      }
      if (clientId && clientId !== record.clientId) {
        oauthError(400, "invalid_grant", "authorization code was issued to another client");
        return;
      }
      if (record.redirectUri !== redirectUri) {
        oauthError(400, "invalid_grant", "redirect_uri mismatch");
        return;
      }
      if (!verifyPkce(verifier, record.codeChallenge)) {
        oauthError(400, "invalid_grant", "PKCE verification failed");
        return;
      }

      const access = store.issueAccessToken(record.connectionId, record.clientId);
      const refresh = store.issueRefreshToken(record.connectionId, record.clientId);
      res.set("Cache-Control", "no-store").json({
        access_token: access.token,
        token_type: "Bearer",
        expires_in: Math.max(1, Math.floor((access.expiresAt - Date.now()) / 1000)),
        refresh_token: refresh.token,
        scope: record.scope,
      });
      return;
    }

    if (grantType === "refresh_token") {
      const refreshToken = body.refresh_token;
      const clientId = body.client_id;
      if (!refreshToken) {
        oauthError(400, "invalid_request", "refresh_token is required");
        return;
      }
      const record = store.verifyRefreshToken(refreshToken);
      if (!record) {
        oauthError(400, "invalid_grant", "refresh_token is invalid or expired");
        return;
      }
      const rotated = store.rotateRefreshToken(refreshToken, clientId ?? record.clientId);
      if (!rotated) {
        oauthError(400, "invalid_grant", "refresh_token rotation failed");
        return;
      }
      res.set("Cache-Control", "no-store").json({
        access_token: rotated.access,
        token_type: "Bearer",
        expires_in: Math.max(1, Math.floor((rotated.expiresAt - Date.now()) / 1000)),
        refresh_token: rotated.refresh,
        scope: "",
      });
      return;
    }

    oauthError(400, "unsupported_grant_type", "only authorization_code and refresh_token are supported");
  });

  return router;
}
