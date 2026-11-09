/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { constantTimeEqual } from "../src/http/auth.js";
import { panelCookie } from "../src/http/cookies.js";
import { allowedCorsOrigin } from "../src/server.js";
import type { Config } from "../src/config.js";

test("constantTimeEqual matches identical secrets", () => {
  assert.equal(constantTimeEqual("local-token-123", "local-token-123"), true);
});

test("constantTimeEqual rejects different secrets and lengths", () => {
  assert.equal(constantTimeEqual("local-token-123", "local-token-124"), false);
  assert.equal(constantTimeEqual("short", "a-much-longer-secret"), false);
  assert.equal(constantTimeEqual("", "x"), false);
});

test("allowedCorsOrigin only echoes configured origins", () => {
  const config = { publicUrl: "https://example.com", port: 3000 } as Pick<Config, "publicUrl" | "port">;
  assert.equal(allowedCorsOrigin(config, "https://example.com"), "https://example.com");
  assert.equal(allowedCorsOrigin(config, "https://example.com/"), "https://example.com/");
  assert.equal(allowedCorsOrigin(config, "http://localhost:3000"), "http://localhost:3000");
  assert.equal(allowedCorsOrigin(config, "https://evil.example"), null);
  assert.equal(allowedCorsOrigin(config, undefined), null);
});

test("panelCookie sets Secure for https or an encrypted request", () => {
  const httpConfig = { publicUrl: "http://example.com" } as Config;
  const httpsConfig = { publicUrl: "https://example.com" } as Config;
  assert.match(panelCookie(httpConfig, "v", 60), /HttpOnly; SameSite=Lax/);
  assert.doesNotMatch(panelCookie(httpConfig, "v", 60), /Secure/);
  assert.match(panelCookie(httpConfig, "v", 60, true), /; Secure/);
  assert.match(panelCookie(httpsConfig, "v", 60), /; Secure/);
});
