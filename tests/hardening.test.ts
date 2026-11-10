/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Regression tests for the P0-P2 hardening pass: retry policy, session expiry,
 * cookie-file parsing, store preservation and origin checks.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Store } from "../src/auth/store.js";
import { AppError } from "../src/errors.js";
import { redact } from "../src/logger.js";
import { McpSessionManager, type McpSession } from "../src/mcp/sessions.js";
import { isAmbiguousUploadFailure } from "../src/soundcloud/api.js";
import { HttpClient } from "../src/soundcloud/http.js";
import { inspectCookieFile } from "../src/web/cookies.js";
import { createLogger } from "../src/logger.js";
import { freePort, seedLocalConnection, startApp, testConfig } from "./helpers.js";

test("non-idempotent requests are not retried on 429, GETs are", async () => {
  const config = testConfig();
  const calls: string[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(String(init?.method ?? "GET"));
    return new Response("{}", { status: 429, headers: { "retry-after": "0" } });
  }) as unknown as typeof fetch;
  const http = new HttpClient({ config, logger: createLogger("error"), getAccessToken: async () => "token", fetchImpl });

  await assert.rejects(http.requestRaw("/tracks", { method: "POST", json: {} }), AppError);
  assert.equal(calls.length, 1, "POST must not be retried");

  calls.length = 0;
  await assert.rejects(http.requestRaw("/me"), AppError);
  assert.equal(calls.length, 3, "GET is retried up to maxRetries");
});

test("isAmbiguousUploadFailure only flags a fully-sent body", () => {
  const timeout = new AppError("TIMEOUT", "x", { status: 504 });
  const tokenExpired = new AppError("TOKEN_EXPIRED", "x", { status: 401 });
  assert.equal(isAmbiguousUploadFailure(100, 100, timeout), true);
  assert.equal(isAmbiguousUploadFailure(99, 100, timeout), false);
  assert.equal(isAmbiguousUploadFailure(100, 100, tokenExpired), false, "401 has no server-side effect");
});

test("expired MCP sessions are closed through delete(), not silently dropped", async () => {
  let closed = 0;
  const manager = new McpSessionManager({ idleTtlMs: 10, maxSessions: 10, logger: createLogger("error") });
  manager.create({
    id: "s1",
    transport: { close: async () => { closed += 1; } } as unknown as McpSession["transport"],
    connectionId: "c",
    tokenHash: "h",
    clientId: "client",
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  manager.sweep();
  assert.equal(manager.size, 0);
  assert.equal(closed, 1);
});

test("store preserves the stored refresh token when bootstrap omits it", () => {
  const config = testConfig();
  const store = new Store(config, createLogger("error"));
  store.ensureLocalConnection({ accessToken: "a1", refreshToken: "r1" });
  store.ensureLocalConnection({ accessToken: "a2" });
  const connection = store.getConnection("local");
  assert.equal(connection?.scAccessToken, "a2");
  assert.equal(connection?.scRefreshToken, "r1");
  store.dispose();
});

test("inspectCookieFile reports malformed JSON instead of throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-malformed-"));
  const file = join(dir, "cookies.json");
  writeFileSync(file, "{not json", { mode: 0o600 });
  const info = inspectCookieFile(file);
  assert.equal(info.exists, true);
  assert.equal(info.malformed, true);
  assert.equal(info.cookies, 0);
});

test("logger redacts tokens, authorization headers and cookie values", () => {
  const output = redact(
    'authorization: Bearer abcdef123456 cookie: scmcp_panel=secretvalue scmcp_at_ABCDEFGHIJKLMNOP access_token=xyz'
  );
  assert.doesNotMatch(output, /abcdef123456/);
  assert.doesNotMatch(output, /secretvalue/);
  assert.doesNotMatch(output, /ABCDEFGHIJKLMNOP/);
  assert.doesNotMatch(output, /xyz/);
  assert.match(output, /REDACTED/);
});

test("health exposes counts, not connection identifiers", async () => {
  const port = await freePort();
  const config = testConfig({ mode: "local", port, publicUrl: `http://127.0.0.1:${port}` });
  const seed = seedLocalConnection(config);
  seed.dispose();
  const app = await startApp(config);
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/health`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { connections: unknown; needs_reauth: unknown };
    assert.equal(typeof body.connections, "number");
    assert.equal(typeof body.needs_reauth, "number");
  } finally {
    await app.close();
  }
});

test("panel mutations accept the loopback origin but reject a foreign one", async () => {
  const port = await freePort();
  const config = testConfig({ mode: "local", port, publicUrl: `http://localhost:${port}` });
  const seed = seedLocalConnection(config);
  seed.dispose();
  const app = await startApp(config);
  try {
    const token = app.store.issueAccessToken("local", "panel").token;
    const request = (origin: string): Promise<Response> =>
      fetch(`http://127.0.0.1:${config.port}/api/social/like`, {
        method: "POST",
        headers: {
          cookie: `scmcp_panel=${token}`,
          origin,
          "x-scmcp-csrf": "1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ kind: "track", urn: "soundcloud:tracks:1", action: "like" }),
      });
    const foreign = await request("http://evil.example");
    assert.equal(foreign.status, 403);
    const loopback = await request(`http://127.0.0.1:${config.port}`);
    assert.notEqual(loopback.status, 403, "127.0.0.1 must be accepted when PUBLIC_URL is localhost");
  } finally {
    await app.close();
  }
});
