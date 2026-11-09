/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { testConfig, freePort, startApp } from "./helpers.js";

function startFakeTokenServer(port: number): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.method === "POST" && req.url?.startsWith("/oauth/token")) {
        req.resume();
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ access_token: "sc-access", refresh_token: "sc-refresh", expires_in: 3600 }));
        });
        return;
      }
      res.writeHead(404).end();
    });
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

test("panel sign-in is a browser redirect flow and never asks for a token", async () => {  const scPort = await freePort();
  const appPort = await freePort();
  const fakeSc = await startFakeTokenServer(scPort);
  const config = testConfig({ mode: "both", port: appPort, publicUrl: `http://127.0.0.1:${appPort}` });
  config.sc.tokenUrl = `http://127.0.0.1:${scPort}/oauth/token`;
  config.sc.authorizeUrl = `http://127.0.0.1:${scPort}/authorize`;
  const app = await startApp(config);
  const base = `http://127.0.0.1:${appPort}`;

  try {
    const loginPage = await fetch(`${base}/panel/login`);
    assert.equal(loginPage.status, 200);
    const loginHtml = await loginPage.text();
    assert.match(loginHtml, /\/panel\/auth\/start/);
    assert.ok(!loginHtml.includes('type="password"'), "login page must not ask for a token");
    assert.ok(!loginHtml.includes('name="token"'), "login page must not have a token field");

    const start = await fetch(`${base}/panel/auth/start`, { redirect: "manual" });
    assert.equal(start.status, 302);
    const authorizeLocation = new URL(start.headers.get("location") ?? "");
    assert.equal(authorizeLocation.origin, `http://127.0.0.1:${scPort}`);
    assert.equal(authorizeLocation.pathname, "/authorize");
    assert.equal(authorizeLocation.searchParams.get("code_challenge_method"), "S256");
    assert.ok((authorizeLocation.searchParams.get("code_challenge") ?? "").length >= 43);
    const state = authorizeLocation.searchParams.get("state");
    assert.ok(state);

    const callback = await fetch(
      `${base}/soundcloud/callback?code=panel-code&state=${encodeURIComponent(state as string)}`,
      { redirect: "manual" }
    );
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get("location"), `${base}/panel`);
    const cookie = callback.headers.getSetCookie().find((value) => value.startsWith("scmcp_panel="));
    assert.ok(cookie, "panel cookie must be set");
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    const token = decodeURIComponent((cookie.split(";")[0] as string).slice("scmcp_panel=".length));
    assert.match(token, /^scmcp_at_/);
    assert.ok(app.store.verifyAccessToken(token), "panel cookie must contain a valid server token");

    const connections = app.store.listConnections();
    assert.equal(connections.length, 1);
    assert.equal(connections[0]?.scAccessToken, "sc-access");
    assert.equal(connections[0]?.scRefreshToken, "sc-refresh");
  } finally {
    await app.close();
    await new Promise<void>((resolve) => fakeSc.close(() => resolve()));
  }
});

test("device setup stores app credentials encrypted and starts the SoundCloud authorize URL", async () => {
  const appPort = await freePort();
  const config = testConfig({ mode: "both", port: appPort, publicUrl: `http://127.0.0.1:${appPort}` });
  config.sc.clientId = undefined;
  config.sc.clientSecret = undefined;
  const app = await startApp(config);
  const base = `http://127.0.0.1:${appPort}`;

  try {
    const setupPage = await fetch(`${base}/panel/setup`);
    assert.equal(setupPage.status, 200);
    const panelBefore = await fetch(`${base}/panel`, { redirect: "manual" });
    assert.equal(panelBefore.status, 302, "no connection yet: panel must redirect to login/setup");
    assert.equal(panelBefore.headers.get("location"), "/panel/login");
    const setupHtml = await setupPage.text();
    assert.match(setupHtml, /name="client_id"/);
    assert.match(setupHtml, /name="client_secret"/);
    assert.match(setupHtml, /soundcloud\/callback/);

    const saved = await fetch(`${base}/panel/setup`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: "client-id-123456", client_secret: "secret-123456" }),
      redirect: "manual",
    });
    assert.equal(saved.status, 302);
    assert.equal(saved.headers.get("location"), "/panel/auth/start");
    assert.deepEqual(app.store.getAppCredentials(), {
      clientId: "client-id-123456",
      clientSecret: "secret-123456",
    });

    const authorize = await fetch(`${base}/panel/auth/start`, { redirect: "manual" });
    assert.equal(authorize.status, 302);
    const location = new URL(authorize.headers.get("location") ?? "");
    assert.equal(location.hostname, "secure.soundcloud.com");
    assert.equal(location.pathname, "/authorize");
    assert.equal(location.searchParams.get("client_id"), "client-id-123456");
    assert.equal(location.searchParams.get("response_type"), "code");
    assert.equal(location.searchParams.get("code_challenge_method"), "S256");
    assert.ok((location.searchParams.get("state") ?? "").length > 10);
  } finally {
    await app.close();
  }
});
