/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createModernServer } from "../src/mcp/modern.js";
import { freePort, seedLocalConnection, startApp, testConfig } from "./helpers.js";

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

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

/** Issue one modern-era (2026-07-28) request against the FastMCP fetch entrypoint. */
async function modernRequest(
  server: ReturnType<typeof createModernServer>,
  method: string,
  params: Record<string, unknown> = {},
  id = 1,
  name?: string
): Promise<{ status: number; body: string }> {
  const response = await server.fetch(
    new Request("http://localhost/mcp-v2", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": method,
        ...(name ? { "mcp-name": name } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: META } }),
    })
  );
  return { status: response.status, body: await response.text() };
}

test("modern 2026-07-28 endpoint serves the full tool registry", async () => {
  const { status, body } = await modernRequest(createModernServer(fakeContext), "tools/list");
  assert.equal(status, 200);
  assert.match(body, /"name":"get_me"/);
  assert.match(body, /"name":"web_upload_track"/);
  assert.match(body, /"name":"trim_audio"/);
});

test("modern 2026-07-28 endpoint serves project resources", async () => {
  const server = createModernServer(fakeContext);
  const list = await modernRequest(server, "resources/list");
  assert.equal(list.status, 200);
  assert.match(list.body, /soundcloud:\/\/guide/);

  const read = await modernRequest(server, "resources/read", { uri: "soundcloud://guide" }, 2, "soundcloud://guide");
  assert.equal(read.status, 200);
  assert.match(read.body, /soundcloud-mcp-server operating guide/);
  assert.match(read.body, /web_upload_track/);
});

test("modern 2026-07-28 endpoint serves prompts", async () => {
  const server = createModernServer(fakeContext);
  const list = await modernRequest(server, "prompts/list");
  assert.equal(list.status, 200);
  assert.match(list.body, /"name":"plan_upload"/);

  const got = await modernRequest(
    server,
    "prompts/get",
    { name: "plan_upload", arguments: { file: "/storage/emulated/0/Download/a.mp3" } },
    2,
    "plan_upload"
  );
  assert.equal(got.status, 200);
  assert.match(got.body, /Upload plan for \/storage\/emulated\/0\/Download\/a\.mp3/);
  assert.match(got.body, /web_upload_track/);
});

test("/mcp-v2 is wired through the HTTP app with bearer auth", async () => {
  const port = await freePort();
  const config = testConfig({ mode: "local", port, publicUrl: `http://127.0.0.1:${port}` });
  seedLocalConnection(config).dispose();
  const app = await startApp(config);
  const endpoint = `http://127.0.0.1:${config.port}/mcp-v2`;
  const body = (method: string, params: Record<string, unknown>) =>
    JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: META } });
  const headers = (method: string, name?: string) => ({
    authorization: `Bearer ${config.security.localToken}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": method,
    ...(name ? { "mcp-name": name } : {}),
  });

  try {
    const tools = await fetch(endpoint, { method: "POST", headers: headers("tools/list"), body: body("tools/list", {}) });
    assert.equal(tools.status, 200);
    const toolsJson = (await tools.json()) as { result: { tools: { name: string }[] } };
    assert.equal(toolsJson.result.tools.length, 50);

    const resource = await fetch(endpoint, {
      method: "POST",
      headers: headers("resources/read", "soundcloud://guide"),
      body: body("resources/read", { uri: "soundcloud://guide" }),
    });
    assert.equal(resource.status, 200);
    assert.match(await resource.text(), /operating guide/);

    const prompt = await fetch(endpoint, {
      method: "POST",
      headers: headers("prompts/get", "plan_upload"),
      body: body("prompts/get", { name: "plan_upload", arguments: { file: "/x.mp3" } }),
    });
    assert.equal(prompt.status, 200);
    assert.match(await prompt.text(), /Upload plan for \/x\.mp3/);
  } finally {
    await app.close();
  }
});
