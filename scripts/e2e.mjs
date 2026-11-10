#!/usr/bin/env node
/*
 * End-to-end smoke for the whole server:
 *   setup -> OAuth (fake SoundCloud) -> panel session -> MCP initialize/tools
 *   -> MP3 upload -> local ID3 tags -> speed change -> track PATCH -> export.
 *
 * Runs against a temporary DATA_DIR and a local fake SoundCloud API. It never
 * touches the real account or the real DATA_DIR. Use `npm run e2e`.
 *
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createServer } from "node:net";
import express from "express";
import Busboy from "busboy";

const exec = promisify(execFile);

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function step(name) {
  process.stdout.write(`• ${name}\n`);
}

async function readUpload(req) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers });
    const fields = {};
    let fileBytes = 0;
    let fileName = "";
    busboy.on("field", (name, value) => {
      fields[name] = value;
    });
    busboy.on("file", (_name, stream, info) => {
      fileName = info.filename;
      stream.on("data", (chunk) => {
        fileBytes += chunk.length;
      });
    });
    busboy.on("error", reject);
    busboy.on("close", () => resolve({ fields, fileBytes, fileName }));
    req.pipe(busboy);
  });
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), "scmcp-e2e-"));
  const scPort = await freePort();
  const appPort = await freePort();
  const scBase = `http://127.0.0.1:${scPort}`;
  const appBase = `http://127.0.0.1:${appPort}`;

  const fake = {
    upload: null,
    updatedTrack: null,
    playlist: { kind: "playlist", id: 20, urn: "soundcloud:playlists:20", title: "E2E Set", tracks: [] },
  };

  const sc = express();
  sc.use(express.json({ limit: "5mb" }));
  sc.post("/oauth/token", (req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      assert.match(body, /grant_type=authorization_code/, "token exchange must be authorization_code");
      assert.match(body, /code_verifier=/, "PKCE verifier must be sent");
      res.json({ access_token: "fake-sc-access", refresh_token: "fake-sc-refresh", expires_in: 3600 });
    });
  });
  sc.get("/me", (_req, res) =>
    res.json({
      kind: "user",
      id: 7,
      urn: "soundcloud:users:7",
      username: "e2e-artist",
      permalink_url: "https://soundcloud.com/e2e-artist",
      plan: "Artist",
      track_count: 1,
      playlist_count: 1,
      followers_count: 3,
      quota: { unlimited_upload_quota: false, upload_seconds_used: 120, upload_seconds_left: 3600 },
      upload_seconds_left: 3600,
    })
  );
  sc.get("/me/tracks", (_req, res) =>
    res.json({ collection: [{ kind: "track", id: 1, urn: "soundcloud:tracks:1", title: "Seed", duration: 60000 }], next_href: null })
  );
  sc.get("/me/playlists", (_req, res) => res.json({ collection: [fake.playlist], next_href: null }));
  sc.get("/me/likes/tracks", (_req, res) => res.json({ collection: [], next_href: null }));
  sc.get("/me/followers", (_req, res) => res.json({ collection: [], next_href: null }));
  sc.get("/me/followings", (_req, res) => res.json({ collection: [], next_href: null }));
  sc.post("/tracks", async (req, res) => {
    const upload = await readUpload(req);
    fake.upload = upload;
    res.status(201).json({ kind: "track", id: 10, urn: "soundcloud:tracks:10", title: upload.fields["track[title]"] });
  });
  sc.put("/tracks/:urn", (req, res) => {
    fake.updatedTrack = req.body;
    res.json({ kind: "track", id: 10, urn: req.params.urn, title: req.body?.track?.title });
  });
  sc.get("/tracks/:urn/streams", (_req, res) =>
    res.json({
      hls_mp3_128_url: "https://cf-media.sndcdn.com/e2e.128.mp3?Policy=eyJTdGF0ZW1lbnQiOlt7IkNvbmRpdGlvbiI6eyJEYXRlTGVzc1RoYW4iOnsiZXBvY2hUaW1lIjoxODAwMDAwMDAwfX19XX0=",
      preview_mp3_128_url: "https://cf-media.sndcdn.com/e2e-preview.mp3",
    })
  );
  sc.get("/playlists/:urn", (_req, res) => res.json(fake.playlist));
  sc.post("/playlists", (req, res) => {
    fake.playlist = { ...fake.playlist, title: req.body?.playlist?.title ?? "E2E Set", tracks: [] };
    res.status(201).json(fake.playlist);
  });
  sc.put("/playlists/:urn", (req, res) => {
    fake.playlist = { ...fake.playlist, ...(req.body?.playlist ?? {}) };
    res.json(fake.playlist);
  });
  sc.delete("/playlists/:urn", (_req, res) => res.status(204).end());

  const scServer = await new Promise((resolve) => {
    const server = sc.listen(scPort, "127.0.0.1", () => resolve(server));
  });

  process.env.DATA_DIR = dataDir;
  process.env.PUBLIC_URL = appBase;
  process.env.PORT = String(appPort);
  process.env.MCP_MODE = "both";
  process.env.MCP_JSON_RESPONSE = "true";
  process.env.MCP_LOCAL_TOKEN = "e2e-local-token-0123456789";
  process.env.MCP_PANEL_AUTO_LOGIN = "false";
  process.env.SC_CLIENT_ID = "e2e-client-id-123456";
  process.env.SC_CLIENT_SECRET = "e2e-client-secret-123456";
  process.env.SC_MEDIA_DIRS = dataDir;
  process.env.SC_MAX_UPLOAD_BYTES = "104857600";
  process.env.LOG_LEVEL = "error";

  const { loadConfig } = await import("../dist/config.js");
  const { createApp } = await import("../dist/server.js");
  const { createLogger } = await import("../dist/logger.js");

  const config = loadConfig();
  config.port = appPort;
  config.publicUrl = appBase;
  config.sc.apiBase = scBase;
  config.sc.tokenUrl = `${scBase}/oauth/token`;
  config.sc.authorizeUrl = `${scBase}/authorize`;

  const handle = createApp(config, createLogger("error"));
  await new Promise((resolve) => {
    if (handle.server.listening) resolve();
    else handle.server.once("listening", resolve);
  });

  const checks = [];
  const ok = (name) => {
    checks.push(name);
    step(name);
  };

  try {
    const health = await fetch(`${appBase}/health`).then((r) => r.json());
    assert.equal(health.status, "ok");
    ok("health");

    const setupPage = await fetch(`${appBase}/panel/setup`);
    assert.equal(setupPage.status, 200);
    assert.match(await setupPage.text(), /client_id/);
    ok("setup page");

    const saved = await fetch(`${appBase}/panel/setup`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: "e2e-client-id-123456", client_secret: "e2e-client-secret-123456" }),
      redirect: "manual",
    });
    assert.equal(saved.status, 302);
    ok("app credentials stored (encrypted)");

    const start = await fetch(`${appBase}/panel/auth/start`, { redirect: "manual" });
    assert.equal(start.status, 302);
    const authorize = new URL(start.headers.get("location"));
    assert.equal(authorize.origin, scBase);
    assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
    const state = authorize.searchParams.get("state");
    assert.ok(state);
    ok("authorize redirect + PKCE");

    const callback = await fetch(`${appBase}/soundcloud/callback?code=e2e-code&state=${encodeURIComponent(state)}`, {
      redirect: "manual",
    });
    assert.equal(callback.status, 302);
    const cookie = callback.headers.getSetCookie().find((value) => value.startsWith("scmcp_panel="));
    assert.ok(cookie, "panel cookie");
    const panelToken = decodeURIComponent(cookie.split(";")[0].slice("scmcp_panel=".length));
    ok("OAuth callback + panel session");

    const stateResponse = await fetch(`${appBase}/api/state`, { headers: { authorization: `Bearer ${panelToken}` } });
    assert.equal(stateResponse.status, 200);
    const panelState = await stateResponse.json();
    assert.equal(panelState.me.username, "e2e-artist");
    ok("panel /api/state");

    const init = await fetch(`${appBase}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${panelToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } },
      }),
    });
    assert.equal(init.status, 200);
    const sessionId = init.headers.get("mcp-session-id");
    assert.ok(sessionId);
    assert.equal((await init.json()).result.serverInfo.name, "soundcloud-mcp-server");
    ok("MCP initialize");

    const tools = await fetch(`${appBase}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${panelToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    assert.equal(tools.status, 200);
    const toolNames = (await tools.json()).result.tools.map((tool) => tool.name);
    assert.ok(toolNames.includes("upload_track"));
    assert.ok(toolNames.includes("edit_audio_tags"));
    assert.ok(toolNames.includes("open_auth_window"));
    assert.ok(toolNames.includes("web_chain_selftest"));
    assert.ok(toolNames.includes("web_cookies_export"));
    assert.ok(toolNames.length >= 55, `expected at least 55 tools, got ${toolNames.length}`);
    ok(`MCP tools/list (${toolNames.length} tools)`);

    const mp3 = join(dataDir, "e2e-tone.mp3");
    const hasFfmpeg = (() => {
      try {
        execFileSync(config.audio.ffmpegPath, ["-version"], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    })();
    if (hasFfmpeg) {
      await exec(config.audio.ffmpegPath, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=1.2",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "128k",
        mp3,
      ]);
      ok("fixture MP3 generated");
    } else {
      // Audio-lab checks need ffmpeg; the upload path only needs a file.
      writeFileSync(mp3, Buffer.alloc(4096, 7));
      console.error("WARN: ffmpeg not found — audio-lab checks will be skipped");
    }

    const uploadForm = new FormData();
    uploadForm.set("upload_id", "e2e-upload-1");
    uploadForm.set("metadata", JSON.stringify({ title: "E2E Track", artist: "E2E Artist", sharing: "private" }));
    uploadForm.set("file", new Blob([await (await import("node:fs/promises")).readFile(mp3)], { type: "audio/mpeg" }), "e2e-tone.mp3");
    const upload = await fetch(`${appBase}/api/upload`, {
      method: "POST",
      headers: { authorization: `Bearer ${panelToken}` },
      body: uploadForm,
    });
    assert.equal(upload.status, 201);
    const uploadBody = await upload.json();
    assert.equal(uploadBody.track.title, "E2E Track");
    assert.equal(fake.upload.fields["track[title]"], "E2E Track");
    assert.equal(fake.upload.fields["track[artist]"], "E2E Artist");
    assert.ok(fake.upload.fileBytes > 1000);
    ok(`streamed multipart upload (${fake.upload.fileBytes} bytes)`);

    if (hasFfmpeg) {
      const tagEdit = await fetch(`${appBase}/api/audio/tags`, {
      method: "POST",
      headers: { authorization: `Bearer ${panelToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        file_path: mp3,
        tags: { title: "E2E Tagged", artist: "E2E Artist", album: "E2E Album", bpm: "140", isrc: "US-E2E-26-00001" },
      }),
    });
    assert.equal(tagEdit.status, 200);
    assert.equal((await tagEdit.json()).tags.title, "E2E Tagged");
    ok("ID3 tags written");

    const speed = await fetch(`${appBase}/api/audio/process`, {
      method: "POST",
      headers: { authorization: `Bearer ${panelToken}`, "content-type": "application/json" },
      body: JSON.stringify({ file_path: mp3, operation: "tempo", ratio: 1.25 }),
    });
    assert.equal(speed.status, 200);
    const speedBody = await speed.json();
    assert.ok(existsSync(speedBody.output_path));
    assert.ok(speedBody.output_path.includes("tempo1.25"));
    ok(`tempo change (${speedBody.output.duration_seconds}s output)`);
    } else {
      console.error("WARN: ffmpeg not found — ID3/tempo checks skipped");
    }

    const patch = await fetch(`${appBase}/api/tracks/soundcloud:tracks:10`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${panelToken}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "E2E Renamed", genre: "Hip-Hop/Rap", sharing: "public" }),
    });
    assert.equal(patch.status, 200);
    assert.equal(fake.updatedTrack.track.title, "E2E Renamed");
    ok("track PATCH → SoundCloud");

    const playlist = await fetch(`${appBase}/api/playlists`, {
      method: "POST",
      headers: { authorization: `Bearer ${panelToken}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "E2E Album", sharing: "private", set_type: "album" }),
    });
    assert.equal(playlist.status, 201);
    assert.equal((await playlist.json()).title, "E2E Album");
    ok("playlist/album create");

    const exported = await fetch(`${appBase}/api/export`, { headers: { authorization: `Bearer ${panelToken}` } });
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get("content-disposition") ?? "", /soundcloud-export/);
    ok("profile export");

    const secondHealth = await fetch(`${appBase}/health`).then((r) => r.json());
    assert.equal(secondHealth.status, "ok");
    ok("final health");

    process.stdout.write(`\nE2E PASS: ${checks.length}/${checks.length} checks\n`);
    process.stdout.write(`  data dir: ${dataDir}\n`);
    process.stdout.write(`  app:      ${appBase}\n`);
    process.stdout.write(`  fake SC:  ${scBase}\n`);
  } finally {
    await handle.close().catch(() => undefined);
    await new Promise((resolve) => scServer.close(resolve));
  }
}

main().catch((error) => {
  console.error(`\nE2E FAIL: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
