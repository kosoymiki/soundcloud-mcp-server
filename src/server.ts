/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import { Store } from "./auth/store.js";
import { TokenService } from "./auth/tokenService.js";
import { createOAuthRouter, isLoopbackAddress } from "./auth/oauth.js";
import { SoundCloudApi } from "./soundcloud/api.js";
import { UploadService } from "./uploads/service.js";
import { AudioService } from "./audio/service.js";
import { pruneStagedUploads } from "./uploads/staging.js";
import { EventBus } from "./events.js";
import { McpSessionManager } from "./mcp/sessions.js";
import { handleModernRequest } from "./mcp/modern.js";
import { createMcpServer } from "./mcp/server.js";
import { Authenticator } from "./http/auth.js";
import { createPanelRouter } from "./panel/api.js";
import { AppError, toAppError } from "./errors.js";
import { redact } from "./logger.js";

export interface ServerHandle {
  app: express.Express;
  server: import("node:http").Server;
  store: Store;
  close: () => Promise<void>;
  url: string;
}

class RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly max: number, private readonly windowMs: number) {}

  allow(key: string): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      if (this.buckets.size > 10_000) this.sweep(now);
      return true;
    }
    if (bucket.count >= this.max) return false;
    bucket.count += 1;
    return true;
  }

  private sweep(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}

function clientKey(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

/** Allow only the configured public origin (plus localhost dev origins). */
export function allowedCorsOrigin(config: Pick<Config, "publicUrl" | "port">, origin: string | undefined): string | null {
  if (!origin) return null;
  const normalize = (value: string): string => value.replace(/\/+$/, "").toLowerCase();
  const allowed = new Set([
    normalize(config.publicUrl),
    normalize(`http://localhost:${config.port}`),
    normalize(`http://127.0.0.1:${config.port}`),
  ]);
  return allowed.has(normalize(origin)) ? origin : null;
}

function securityHeaders(config: Config) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (config.publicUrl.startsWith("https://")) {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  };
}

function corsForMcp(config: Config) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    const allowed = allowedCorsOrigin(config, origin);
    if (allowed) {
      res.setHeader("Access-Control-Allow-Origin", allowed);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, mcp-session-id, MCP-Protocol-Version, Last-Event-ID"
    );
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id, WWW-Authenticate");
    next();
  };
}

export function createApp(config: Config, logger: Logger): ServerHandle {
  const store = new Store(config, logger);
  const events = new EventBus();
  const tokens = new TokenService(store, config, logger);
  const authenticator = new Authenticator(config, store);
  const sessions = new McpSessionManager({
    idleTtlMs: config.security.sessionIdleTtlMs,
    maxSessions: 100,
    logger,
  });

  const apiFactory = (connectionId: string): SoundCloudApi =>
    new SoundCloudApi({
      config,
      logger: logger.child({ connection: connectionId }),
      tokens,
      getAccessToken: (options) => tokens.getAccessToken(connectionId, options ?? {}),
    });

  const uploads = new UploadService(config, logger, events, apiFactory("local"));
  const audio = new AudioService(config, logger, events, uploads);
  void pruneStagedUploads(join(config.dataDir, "uploads")).then((removed) => {
    if (removed > 0) logger.info("Pruned staged uploads", { removed });
  });

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", (process.env.MCP_TRUST_PROXY ?? "false") === "true");
  app.use(securityHeaders(config));

  const publicHost = new URL(config.publicUrl).host;
  const allowedHosts = new Set([publicHost, `localhost:${config.port}`, `127.0.0.1:${config.port}`]);

  const authLimiter = new RateLimiter(60, 60_000);
  const apiLimiter = new RateLimiter(600, 60_000);

  // Health — public, no secrets.
  app.get("/health", (_req, res) => {
    res.setHeader("Cache-Control", "no-store").json({
      status: "ok",
      version: config.version,
      mode: config.mode,
      uptime_seconds: Math.round((Date.now() - config.startedAt) / 1000),
      mcp_sessions: sessions.size,
      connections: store.listConnections().map((connection) => ({
        id: connection.id,
        label: connection.label,
        needs_reauth: connection.needsReauth === true,
        expires_at: new Date(connection.scExpiresAt).toISOString(),
      })),
    });
  });

  // Protected diagnostics (replaces the donor's unauthenticated token proxy).
  app.get("/diagnostic", async (req, res, next) => {
    try {
      const auth = authenticator.authenticate(req);
      if (!auth) {
        res.status(401).json({ error: true, code: "UNAUTHORIZED", message: "Bearer token required." });
        return;
      }
      const api = apiFactory(auth.connectionId);
      const [me, quota] = await Promise.all([api.me(), api.quota()]);
      res.json({
        connection: auth.connectionId,
        token_expires_at: new Date(
          store.getConnection(auth.connectionId)?.scExpiresAt ?? 0
        ).toISOString(),
        me: {
          id: me.id,
          urn: me.urn,
          username: me.username,
          permalink_url: me.permalink_url,
          plan: me.plan,
        },
        quota,
        api_base: config.sc.apiBase,
        auth_host: config.sc.authBase,
        auth_scheme: config.sc.authScheme,
      });
    } catch (error) {
      next(toAppError(error));
    }
  });

  app.use((req, res, next) => {
    const host = req.headers.host;
    if (req.path.startsWith("/mcp") && typeof host === "string" && !allowedHosts.has(host)) {
      res.status(421).json({ error: true, code: "FORBIDDEN", message: "Unexpected Host header." });
      return;
    }
    next();
  });

  app.options("*", corsForMcp(config), (_req, res) => res.status(204).end());

  // OAuth / discovery / SoundCloud callback
  app.use((req, res, next) => {
    if (!req.path.startsWith("/.well-known") && !req.path.startsWith("/oauth") && !req.path.startsWith("/register") && !req.path.startsWith("/soundcloud")) {
      next();
      return;
    }
    if (!authLimiter.allow(clientKey(req))) {
      res.status(429).json({ error: true, code: "RATE_LIMITED", message: "Too many authentication requests." });
      return;
    }
    next();
  });
  app.use(createOAuthRouter({ config, store, tokens, logger }));

  // Panel auth endpoints share the authentication rate limit.
  app.use((req, res, next) => {
    if (!req.path.startsWith("/panel/auth")) {
      next();
      return;
    }
    if (!authLimiter.allow(clientKey(req))) {
      res.status(429).json({ error: true, code: "RATE_LIMITED", message: "Too many authentication requests." });
      return;
    }
    next();
  });

  // Panel UI + REST API
  app.use(
    createPanelRouter({
      config,
      store,
      apiFactory,
      uploads,
      audio,
      events,
      authenticator,
      logger,
    })
  );

  // Modern-era MCP endpoint (2026-07-28) — same tools, FastMCP transport.
  app.all("/mcp-v2", corsForMcp(config), async (req: Request, res: Response) => {
    if (!apiLimiter.allow(clientKey(req))) {
      res.status(429).json({ error: true, code: "RATE_LIMITED", message: "Too many MCP requests." });
      return;
    }
    const auth = authenticator.authenticate(req);
    if (!auth) {
      res.status(401).json({ error: true, code: "UNAUTHORIZED", message: "Bearer token required." });
      return;
    }
    if (!store.getConnection(auth.connectionId)) {
      res.status(401).json({ error: true, code: "NEEDS_REAUTH", message: "Connection missing." });
      return;
    }
    const modernContext = {
      api: apiFactory(auth.connectionId),
      uploads: uploads.withApi(apiFactory(auth.connectionId)),
      audio,
      config,
      logger: logger.child({ connection: auth.connectionId }),
      events,
      connectionId: auth.connectionId,
      isLoopback: isLoopbackAddress(req.socket.remoteAddress),
    };
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) value.forEach((item) => headers.append(key, item));
        else if (typeof value === "string") headers.append(key, value);
      }
      const url = new URL(req.originalUrl || "/mcp-v2", config.publicUrl).toString();
      // Abort the FastMCP request when the client disconnects (SSE streams live until then).
      const disconnect = new AbortController();
      res.on("close", () => disconnect.abort());
      const webRequest = new Request(url, {
        method: req.method,
        headers,
        signal: disconnect.signal,
        ...(body && req.method !== "GET" && req.method !== "HEAD" ? { body: body as unknown as BodyInit } : {}),
      });
      const response = await handleModernRequest(webRequest, modernContext);
      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));
      if (!response.body) {
        res.end();
        return;
      }
      // Stream instead of buffering: subscriptions/listen and notification
      // streams stay open for the life of the connection.
      await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), res);
    } catch (error) {
      if (res.headersSent || res.writableEnded) {
        res.destroy();
        return;
      }
      res.status(500).json({ error: true, code: "INTERNAL", message: error instanceof Error ? error.message : String(error) });
    }
  });

  // MCP endpoint (Streamable HTTP)
  app.all("/mcp", corsForMcp(config), express.json({ limit: "4mb" }), async (req: Request, res: Response) => {    if (!apiLimiter.allow(clientKey(req))) {
      res.status(429).json({ error: true, code: "RATE_LIMITED", message: "Too many MCP requests." });
      return;
    }

    const auth = authenticator.authenticate(req);
    if (!auth) {
      res.setHeader(
        "WWW-Authenticate",
        `Bearer realm="${config.publicUrl}", resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource/mcp"`
      );
      res.status(401).json({
        error: true,
        code: "UNAUTHORIZED",
        message:
          config.mode === "local"
            ? "Send the local token as `Authorization: Bearer <token>`."
            : "Complete the OAuth flow or send a Bearer token.",
      });
      return;
    }

    const sessionId = req.headers["mcp-session-id"];
    if (typeof sessionId === "string" && sessionId.length > 0) {
      const session = sessions.get(sessionId);
      if (!session) {
        res.status(404).json({ error: true, code: "NOT_FOUND", message: "Session not found or expired." });
        return;
      }
      if (!sessions.tokenMatches(session, auth.tokenHash)) {
        res.status(403).json({
          error: true,
          code: "FORBIDDEN",
          message: "This session belongs to a different access token.",
        });
        return;
      }
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    if (req.method !== "POST") {
      res.status(400).json({
        error: true,
        code: "BAD_REQUEST",
        message: "New sessions must be initialized with POST.",
      });
      return;
    }

    const newSessionId = randomUUID();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
      enableJsonResponse: config.jsonResponse,
    });
    const connection = store.getConnection(auth.connectionId);
    if (!connection) {
      res.status(401).json({ error: true, code: "NEEDS_REAUTH", message: "Connection missing." });
      return;
    }

    const isLoopback = isLoopbackAddress(req.socket.remoteAddress);
    const server = createMcpServer({
      api: apiFactory(auth.connectionId),
      uploads: uploads.withApi(apiFactory(auth.connectionId)),
      audio,
      config,
      logger: logger.child({ session: newSessionId, connection: auth.connectionId }),
      events,
      connectionId: auth.connectionId,
      isLoopback,
    });

    transport.onclose = () => {
      sessions.delete(newSessionId);
      void server.close().catch(() => undefined);
      logger.debug("MCP session closed", { session: newSessionId });
    };
    transport.onerror = (error) => {
      logger.warn("MCP transport error", { session: newSessionId, error: error.message });
    };

    sessions.create({
      id: newSessionId,
      transport,
      connectionId: auth.connectionId,
      tokenHash: auth.tokenHash,
      clientId: auth.clientId,
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      sessions.delete(newSessionId);
      logger.error("MCP session initialization failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        res.status(500).json({ error: true, code: "INTERNAL", message: "Failed to initialize MCP session." });
      }
    }
  });

  app.use((req: Request, res: Response) => {
    if (req.path.startsWith("/api/") || req.path === "/mcp" || req.path === "/diagnostic") {
      res.status(404).json({ error: true, code: "NOT_FOUND", message: `No route for ${req.method} ${req.path}.` });
      return;
    }
    res.status(404).type("text/plain").send(`Not found: ${redact(req.path)}`);
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const appError = toAppError(error);
    logger.warn("Request failed", {
      code: appError.code,
      status: appError.options.status,
      message: appError.message,
    });
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(appError.options.status ?? 500).json(appError.toJSON());
  });

  const sweep = setInterval(() => sessions.sweep(), 60_000);
  sweep.unref();

  const server = app.listen(config.port, config.host);

  const close = async (): Promise<void> => {
    clearInterval(sweep);
    sessions.closeAll();
    store.dispose();
    events.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return {
    app,
    server,
    store,
    close,
    url: `http://${config.host}:${config.port}`,
  };
}

export function guardMode(config: Config): void {
  if (config.mode === "local" && !config.security.localToken) {
    throw new AppError("INTERNAL", "Local mode requires MCP_LOCAL_TOKEN.", { status: 500 });
  }
  if (config.mode === "oauth" && (!config.sc.clientId || !config.sc.clientSecret)) {
    // OAuth mode can still accept credentials entered in the login form.
    return;
  }
}
