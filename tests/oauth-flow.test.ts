/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { pkcePair } from "../src/auth/crypto.js";
import { testConfig, freePort, seedLocalConnection, startApp } from "./helpers.js";

function startFakeSoundCloud(port: number): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.method === "POST" && req.url?.startsWith("/oauth/token")) {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          assert.match(body, /grant_type=authorization_code/);
          assert.match(body, /code_verifier=/);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              access_token: "sc-access-token",
              refresh_token: "sc-refresh-token",
              expires_in: 3600,
              scope: "",
            })
          );
        });
        return;
      }
      res.writeHead(404).end();
    });
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

async function jsonRpc(
  url: string,
  token: string,
  body: unknown,
  sessionId?: string
): Promise<{ status: number; json: any; sessionId: string | null }> {
  const response = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    const match = /data: (\{.*\})/.exec(text);
    if (match?.[1]) json = JSON.parse(match[1]);
  }
  return { status: response.status, json, sessionId: response.headers.get("mcp-session-id") };
}

test("full OAuth 2.1 + PKCE flow issues MCP tokens and binds sessions to them", async () => {
  const scPort = await freePort();
  const appPort = await freePort();
  const fakeSc = await startFakeSoundCloud(scPort);
  const config = testConfig({ mode: "oauth", port: appPort, publicUrl: `http://127.0.0.1:${appPort}` });
  config.sc.tokenUrl = `http://127.0.0.1:${scPort}/oauth/token`;
  config.sc.authorizeUrl = `http://127.0.0.1:${scPort}/authorize`;
  // Exercise the fallback form path: no app credentials from env.
  config.sc.clientId = undefined;
  config.sc.clientSecret = undefined;
  seedLocalConnection(config).dispose();
  const app = await startApp(config);
  const base = `http://127.0.0.1:${appPort}`;

  try {
    const redirectUri = `http://127.0.0.1:${appPort}/callback`;
    const registration = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "test-client" }),
    });
    assert.equal(registration.status, 201);
    const client = (await registration.json()) as { client_id: string };

    const pkce = pkcePair();
    const authorizeUrl = new URL(`${base}/oauth/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", client.client_id);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("state", "state-123");
    authorizeUrl.searchParams.set("code_challenge", pkce.challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    const authorizePage = await fetch(authorizeUrl, { redirect: "manual" });
    assert.equal(authorizePage.status, 200);
    const html = await authorizePage.text();
    assert.match(html, /Authorize test-client/);
    assert.match(html, /value="allow"/);
    assert.match(html, /value="deny"/);
    assert.match(html, new RegExp(redirectUri.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const flow = /name="flow" value="([^"]+)"/.exec(html)?.[1];
    assert.ok(flow, "login page must include a signed flow");
    const cookie = authorizePage.headers.getSetCookie().find((value) => value.startsWith("scmcp_flow="));
    assert.ok(cookie);

    const form = new URLSearchParams({
      flow,
      decision: "allow",
      sc_client_id: "sc-client",
      sc_client_secret: "sc-secret",
    });
    const authorizePost = await fetch(`${base}/oauth/authorize`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: cookie.split(";")[0] as string,
      },
      body: form,
      redirect: "manual",
    });
    const authorizePostBody = await authorizePost.text();
    assert.equal(authorizePost.status, 302, authorizePostBody);
    const scLocation = new URL(authorizePost.headers.get("location") ?? "");
    assert.equal(scLocation.hostname, "127.0.0.1");
    assert.equal(scLocation.pathname, "/authorize");
    const scState = scLocation.searchParams.get("state");
    assert.ok(scState);

    // Denying consent must return access_denied to the registered redirect URI.
    const denyForm = new URLSearchParams({ flow, decision: "deny" });
    const denied = await fetch(`${base}/oauth/authorize`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: cookie.split(";")[0] as string,
      },
      body: denyForm,
      redirect: "manual",
    });
    assert.equal(denied.status, 302);
    const deniedLocation = new URL(denied.headers.get("location") ?? "");
    assert.equal(deniedLocation.searchParams.get("error"), "access_denied");
    assert.equal(deniedLocation.searchParams.get("state"), "state-123");

    const callback = await fetch(
      `${base}/soundcloud/callback?code=sc-auth-code&state=${encodeURIComponent(scState)}`,
      { redirect: "manual" }
    );
    const callbackBody = await callback.text();
    assert.equal(callback.status, 302, callbackBody);
    const clientRedirect = new URL(callback.headers.get("location") ?? "");
    assert.equal(clientRedirect.origin + clientRedirect.pathname, redirectUri);
    assert.equal(clientRedirect.searchParams.get("state"), "state-123");
    const authCode = clientRedirect.searchParams.get("code");
    assert.ok(authCode);

    const tokenResponse = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: authCode,
        client_id: client.client_id,
        redirect_uri: redirectUri,
        code_verifier: pkce.verifier,
      }),
    });
    assert.equal(tokenResponse.status, 200);
    const tokens = (await tokenResponse.json()) as { access_token: string; refresh_token: string; expires_in: number };
    assert.match(tokens.access_token, /^scmcp_at_/);
    assert.match(tokens.refresh_token, /^scmcp_rt_/);
    assert.ok(tokens.expires_in > 0);

    const init = await jsonRpc(base, tokens.access_token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    });
    assert.equal(init.status, 200, JSON.stringify(init.json));
    assert.equal(init.json?.result?.serverInfo?.name, "soundcloud-mcp-server");
    assert.ok(init.sessionId);

    const list = await jsonRpc(
      base,
      tokens.access_token,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      init.sessionId ?? undefined
    );
    assert.equal(list.status, 200, JSON.stringify(list.json));
    const names = (list.json?.result?.tools ?? []).map((tool: { name: string }) => tool.name);
    for (const expected of [
      "get_me",
      "update_profile",
      "upload_track",
      "get_stream_url",
      "create_playlist",
      "reorder_playlist",
      "edit_audio_tags",
      "change_audio_speed",
      "audio_probe",
    ]) {
      assert.ok(names.includes(expected), `missing tool ${expected}`);
    }

    app.store.ensureLocalConnection({ accessToken: "unrelated-access" });
    const otherToken = app.store.issueAccessToken("local", "other-client").token;
    const hijack = await jsonRpc(
      base,
      otherToken,
      { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
      init.sessionId ?? undefined
    );
    assert.equal(hijack.status, 403);

    const unauthorized = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(unauthorized.status, 401);
    assert.match(unauthorized.headers.get("www-authenticate") ?? "", /resource_metadata=/);

    const badRedirect = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }),
    });
    assert.equal(badRedirect.status, 400);
  } finally {
    await app.close();
    await new Promise<void>((resolve) => fakeSc.close(() => resolve()));
  }
});

test("authorize rejects redirect_uri that was not registered for the client", async () => {
  const appPort = await freePort();
  const config = testConfig({ mode: "oauth", port: appPort, publicUrl: `http://127.0.0.1:${appPort}` });
  const app = await startApp(config);
  try {
    const registration = await fetch(`http://127.0.0.1:${appPort}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:1/cb"] }),
    });
    const client = (await registration.json()) as { client_id: string };
    const pkce = pkcePair();
    const url = new URL(`http://127.0.0.1:${appPort}/oauth/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", client.client_id);
    url.searchParams.set("redirect_uri", "http://127.0.0.1:2/other");
    url.searchParams.set("state", "s");
    url.searchParams.set("code_challenge", pkce.challenge);
    url.searchParams.set("code_challenge_method", "S256");
    const response = await fetch(url, { redirect: "manual" });
    assert.equal(response.status, 400);
  } finally {
    await app.close();
  }
});
