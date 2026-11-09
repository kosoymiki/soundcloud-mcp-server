/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderLoginPage, renderPanel } from "../src/panel/ui.js";
import { testConfig } from "./helpers.js";

test("panel HTML contains every expected section and valid browser JS", () => {
  const config = testConfig();
  const html = renderPanel(config, "test-nonce");
  for (const id of ["sec-overview", "sec-upload", "sec-audio", "sec-tracks", "sec-playlists", "sec-social", "sec-settings"]) {
    assert.ok(html.includes(`id="${id}"`), `missing ${id}`);
  }
  for (const id of ["al-probe", "al-stage", "al-save-tags", "al-apply-speed", "al-normalize", "al-trim", "al-convert", "al-upload"]) {
    assert.ok(html.includes(`id="${id}"`), `missing ${id}`);
  }
  const script = /<script nonce="test-nonce">([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script, "panel script missing");
  // Parse (not execute) the browser code to catch template-literal escaping bugs.
  new Function(script);
});

test("browser login page never exposes a token field", () => {
  const config = testConfig();
  const html = renderLoginPage(config, "n", { canConnect: true, hasConnection: false });
  assert.match(html, /\/panel\/auth\/start/);
  assert.ok(!html.includes('type="password"'));
  assert.ok(!html.includes('name="token"'));
  const missing = renderLoginPage(config, "n", { canConnect: false, hasConnection: false });
  assert.match(missing, /SC_CLIENT_ID/);
  assert.ok(!missing.includes("/panel/auth/start"));
});
