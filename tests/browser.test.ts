/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { detectPlatform, openInBrowser } from "../src/util/browser.js";

test("platform detection covers Android, Windows, macOS, Linux and WSL", () => {
  assert.equal(detectPlatform({ TERMUX_VERSION: "0.119" }, "linux"), "android");
  assert.equal(detectPlatform({}, "android"), "android");
  assert.equal(detectPlatform({}, "win32"), "windows");
  assert.equal(detectPlatform({}, "darwin"), "macos");
  assert.equal(detectPlatform({ WSL_DISTRO_NAME: "Ubuntu" }, "linux"), "wsl");
  assert.equal(detectPlatform({}, "linux"), "linux");
  assert.equal(detectPlatform({}, "freebsd"), "unknown");
});

test("unknown platform returns the URL instead of throwing", async () => {
  const result = await openInBrowser("http://localhost:3000/panel/auth/start", { platform: "unknown" });
  assert.equal(result.opened, false);
  assert.equal(result.platform, "unknown");
  assert.ok(result.reason && result.reason.length > 0);
});
