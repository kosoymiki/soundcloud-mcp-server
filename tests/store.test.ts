/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/auth/store.js";
import { TokenService } from "../src/auth/tokenService.js";
import { createLogger } from "../src/logger.js";
import { NeedsReauthError } from "../src/errors.js";
import { testConfig } from "./helpers.js";

test("issued MCP tokens verify, persist across restarts and rotate single-use", () => {
  const config = testConfig();
  const logger = createLogger("error");
  const store = new Store(config, logger);
  store.ensureLocalConnection({ accessToken: "a", refreshToken: "r", clientId: "c", clientSecret: "s" });

  const access = store.issueAccessToken("local", "client-1");
  const refresh = store.issueRefreshToken("local", "client-1");
  assert.ok(store.verifyAccessToken(access.token));
  assert.equal(store.verifyAccessToken(refresh.token), null, "refresh token is not an access token");

  const rotated = store.rotateRefreshToken(refresh.token, "client-1");
  assert.ok(rotated);
  assert.equal(store.verifyRefreshToken(refresh.token), null, "old refresh token must be invalidated");
  assert.ok(store.verifyAccessToken(rotated?.access ?? ""));
  assert.ok(store.verifyRefreshToken(rotated?.refresh ?? ""));

  const storePath = join(config.dataDir, "state.enc");
  assert.ok(storePath.length > 0);
  const reloaded = new Store(config, logger);
  assert.ok(reloaded.verifyAccessToken(rotated?.access ?? ""));
  assert.equal(reloaded.getConnection("local")?.scAccessToken, "a");

  store.dispose();
  reloaded.dispose();
  rmSync(config.dataDir, { recursive: true, force: true });
});

test("auth codes are single-use and expire by consumption", () => {
  const config = testConfig();
  const store = new Store(config, createLogger("error"));
  const code = store.storeAuthCode({
    connectionId: "local",
    clientId: "client",
    redirectUri: "http://127.0.0.1/cb",
    codeChallenge: "challenge",
    scope: "",
    expiresAt: Date.now() + 60_000,
  });
  assert.ok(store.consumeAuthCode(code));
  assert.equal(store.consumeAuthCode(code), null);
  store.dispose();
});

test("token refresh rotates the single-use refresh token and persists it", async () => {
  const config = testConfig();
  const logger = createLogger("error");
  const store = new Store(config, logger);
  store.ensureLocalConnection({
    accessToken: "old-access",
    refreshToken: "old-refresh",
    clientId: "cid",
    clientSecret: "secret",
    expiresIn: 1,
  });

  let capturedBody = "";
  const tokens = new TokenService(
    store,
    config,
    logger,
    (async (_url, init) => {
      capturedBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }),
        { headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch
  );

  const connection = await tokens.refresh("local");
  assert.equal(connection.scAccessToken, "new-access");
  assert.equal(connection.scRefreshToken, "new-refresh");
  assert.match(capturedBody, /grant_type=refresh_token/);
  assert.match(capturedBody, /refresh_token=old-refresh/);
  assert.equal(store.getConnection("local")?.scRefreshToken, "new-refresh");
  store.dispose();
});

test("invalid_grant marks the connection as needing re-authentication", async () => {
  const config = testConfig();
  const logger = createLogger("error");
  const store = new Store(config, logger);
  store.ensureLocalConnection({
    accessToken: "old",
    refreshToken: "burned",
    clientId: "cid",
    clientSecret: "secret",
    expiresIn: 1,
  });
  const tokens = new TokenService(
    store,
    config,
    logger,
    (async () => new Response("invalid_grant", { status: 400 })) as typeof fetch
  );

  await assert.rejects(() => tokens.refresh("local"), NeedsReauthError);
  assert.equal(store.getConnection("local")?.needsReauth, true);
  store.dispose();
});

test("concurrent refreshes are single-flighted", async () => {
  const config = testConfig();
  const logger = createLogger("error");
  const store = new Store(config, logger);
  store.ensureLocalConnection({
    accessToken: "old",
    refreshToken: "refresh",
    clientId: "cid",
    clientSecret: "secret",
    expiresIn: 1,
  });
  let fetchCalls = 0;
  const tokens = new TokenService(
    store,
    config,
    logger,
    (async () => {
      fetchCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return new Response(JSON.stringify({ access_token: "new-access-token", refresh_token: "r2", expires_in: 3600 }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch
  );

  const [a, b] = await Promise.all([tokens.getAccessToken("local"), tokens.getAccessToken("local")]);
  assert.equal(a, "new-access-token");
  assert.equal(b, "new-access-token");
  assert.equal(fetchCalls, 1);
  store.dispose();
});
