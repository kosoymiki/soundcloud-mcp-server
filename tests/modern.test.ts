/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createModernServer } from "../src/mcp/modern.js";

const fakeContext = {
  api: {},
  uploads: {},
  audio: {},
  config: { version: "2.0.0" },
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  events: {},
  connectionId: "test",
  isLoopback: true,
} as never;

test("modern 2026-07-28 endpoint serves the full tool registry", async () => {
  const server = createModernServer(fakeContext);
  const meta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  const response = await server.fetch(
    new Request("http://localhost/mcp-v2", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/list",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta } }),
    })
  );
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /"name":"get_me"/);
  assert.match(body, /"name":"web_upload_track"/);
  assert.match(body, /"name":"trim_audio"/);
});
