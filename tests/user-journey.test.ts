/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * User-reproducible journey tests. Every step uses the same interface a real
 * user has: the HTTP server, the MCP transports, the panel REST API, the CLI
 * binaries and the installer. No internal mocks of our own modules.
 *
 * Covered chains:
 *   1. fresh DATA_DIR bootstrap (generated secrets, health, login page)
 *   2. legacy MCP client: initialize -> tools/list -> read calls -> upload ->
 *      edit -> playlist add/remove -> delete
 *   3. modern MCP client (2026-07-28): tools/call, resources/read, prompts/get
 *   4. panel REST: state, multipart upload, patch, playlists, social, export,
 *      web-session status
 *   5. CLI: chrome cookie export -> doctor (valid + corrupt), sc.mjs against
 *      the running server
 *   6. installer --dry-run
 */

import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";import { after, before, test } from "node:test";
import type { Config } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import { freePort, seedLocalConnection, startApp, testConfig } from "./helpers.js";

type Json = Record<string, unknown>;

const execFileAsync = promisify(execFile);

const TRACK = (id = 1001): Json => ({
  kind: "track",
  id,
  urn: `soundcloud:tracks:${id}`,
  title: `Journey track ${id}`,
  permalink: `journey-${id}`,
  permalink_url: `https://soundcloud.com/tester/journey-${id}`,
  duration: 30_000,
  sharing: "public",
  streamable: true,
  access: "playable",
  playback_count: 1,
  user: { username: "tester" },
});

const PLAYLIST = (id = 2001, tracks: string[] = []): Json => ({
  kind: "playlist",
  id,
  urn: `soundcloud:playlists:${id}`,
  title: `Journey playlist ${id}`,
  permalink_url: `https://soundcloud.com/tester/sets/journey-${id}`,
  track_count: tracks.length,
  tracks: tracks.map((urn) => ({ urn })),
});

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Minimal SoundCloud API double: every route a journey touches. */
function startFakeSoundCloud(port: number): Promise<{ server: Server; state: { uploads: number; uploadBytes: number; putTracks: number; deletes: number } }> {
  const state = { uploads: 0, uploadBytes: 0, putTracks: 0, deletes: 0 };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = decodeURIComponent(url.pathname);
    const method = req.method ?? "GET";

    if (method === "GET" && path === "/me") {
      send(res, 200, {
        kind: "user", id: 9, urn: "soundcloud:users:9", username: "tester",
        permalink_url: "https://soundcloud.com/tester", plan: "free",
        track_count: 1, playlist_count: 1, followers_count: 0, playlist_likes_count: 0,
        upload_seconds_left: 7200, quota: { unlimited_upload_quota: false, upload_seconds_used: 0, upload_seconds_left: 7200 },
      });
      return;
    }
    if (method === "GET" && path === "/me/tracks") { send(res, 200, { collection: [TRACK()], next_href: null }); return; }
    if (method === "GET" && path === "/me/playlists") { send(res, 200, { collection: [PLAYLIST(2001, ["soundcloud:tracks:1001"])], next_href: null }); return; }
    if (method === "GET" && path === "/me/likes/tracks") { send(res, 200, { collection: [TRACK(1002)], next_href: null }); return; }
    if (method === "GET" && path === "/me/reposts/tracks") { send(res, 200, { collection: [], next_href: null }); return; }
    if (method === "GET" && (path === "/me/followers" || path === "/me/followings")) { send(res, 200, { collection: [], next_href: null }); return; }
    if (method === "GET" && path === "/me/activities") { send(res, 200, { collection: [], next_href: null }); return; }
    if (method === "PUT" && path.startsWith("/me/followings/")) { send(res, 200, {}); return; }
    if (method === "DELETE" && path.startsWith("/me/followings/")) { send(res, 204); return; }

    if (method === "GET" && path === "/resolve") { send(res, 200, TRACK()); return; }
    if (method === "GET" && /^\/users\/[^/]+$/.test(path)) { send(res, 200, { kind: "user", id: 9, urn: "soundcloud:users:9", username: "tester" }); return; }
    if (method === "GET" && /^\/users\/[^/]+\/tracks$/.test(path)) { send(res, 200, { collection: [TRACK()], next_href: null }); return; }
    if (method === "GET" && /^\/users\/[^/]+\/playlists$/.test(path)) { send(res, 200, { collection: [], next_href: null }); return; }
    if (method === "GET" && /^\/users\/[^/]+\/(followers|followings)$/.test(path)) { send(res, 200, { collection: [], next_href: null }); return; }

    if (method === "POST" && path === "/tracks") {
      const body = await readBody(req);
      state.uploads += 1;
      state.uploadBytes += body.length;
      send(res, 201, TRACK(1003));
      return;
    }
    if (method === "GET" && /^\/tracks\/[^/]+$/.test(path)) { send(res, 200, TRACK()); return; }
    if (method === "PUT" && /^\/tracks\/[^/]+$/.test(path)) {
      const body = await readBody(req);
      state.putTracks += 1;
      const parsed = body.length > 0 ? (JSON.parse(body.toString("utf8")) as { track?: Json }) : {};
      send(res, 200, { ...TRACK(), ...(parsed.track ?? {}) });
      return;
    }
    if (method === "DELETE" && /^\/tracks\/[^/]+$/.test(path)) { state.deletes += 1; send(res, 204); return; }
    if (method === "GET" && /^\/tracks\/[^/]+\/streams$/.test(path)) {
      send(res, 200, { hls_mp3_128_url: "https://cf-media.sndcdn.com/x.128.mp3?Expires=1900000000" });
      return;
    }
    if (method === "GET" && /^\/tracks\/[^/]+\/comments$/.test(path)) { send(res, 200, { collection: [], next_href: null }); return; }
    if (method === "POST" && /^\/tracks\/[^/]+\/comments$/.test(path)) { send(res, 201, { id: 1, body: "hi" }); return; }

    if (method === "GET" && /^\/playlists\/[^/]+$/.test(path)) {
      const urn = path.split("/")[2] ?? "soundcloud:playlists:2001";
      send(res, 200, PLAYLIST(Number(urn.split(":").pop()), ["soundcloud:tracks:1001"]));
      return;
    }
    if (method === "POST" && path === "/playlists") {
      await readBody(req);
      send(res, 201, PLAYLIST(2002));
      return;
    }
    if (method === "PUT" && /^\/playlists\/[^/]+$/.test(path)) { await readBody(req); send(res, 200, PLAYLIST(2001, ["soundcloud:tracks:1001"])); return; }
    if (method === "DELETE" && /^\/playlists\/[^/]+$/.test(path)) { state.deletes += 1; send(res, 204); return; }

    if ((method === "POST" || method === "DELETE") && /^\/(likes|reposts)\/(tracks|playlists)\/[^/]+$/.test(path)) {
      send(res, method === "POST" ? 200 : 204, method === "POST" ? {} : undefined);
      return;
    }
    send(res, 404, { error: "not found", path, method });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve({ server, state }));
  });
}

let scServer: Server;
let scState: { uploads: number; uploadBytes: number; putTracks: number; deletes: number };
let app: Awaited<ReturnType<typeof startApp>>;
let config: Config;
let base: string;
let scBase: string;
let cookieToken: string;
let tonePath: string;

before(async () => {
  const scPort = await freePort();
  const appPort = await freePort();
  scBase = `http://127.0.0.1:${scPort}`;
  const fake = await startFakeSoundCloud(scPort);
  scServer = fake.server;
  scState = fake.state;
  config = testConfig({ mode: "local", port: appPort, publicUrl: `http://127.0.0.1:${appPort}` });
  config.sc.apiBase = scBase;
  config.sc.tokenUrl = `${scBase}/oauth/token`;
  // Journey tests authenticate explicitly (cookie/token), so loopback must not
  // silently auto-login and turn a 401 check into a 200.
  config.security.panelAutoLogin = false;
  seedLocalConnection(config, "sc-access-token").dispose();
  app = await startApp(config);
  base = `http://127.0.0.1:${config.port}`;
  cookieToken = app.store.issueAccessToken("local", "panel").token;
  tonePath = join(config.dataDir, "journey.mp3");
  // The mock SoundCloud does not decode audio; 4 KB of bytes is enough for the
  // multipart/ID3-tolerant path and keeps the test fast.
  writeFileSync(tonePath, Buffer.alloc(4096, 7));
});

after(async () => {
  app.server.closeAllConnections();
  await app.close();
  scServer.closeAllConnections();
  await new Promise<void>((resolve) => scServer.close(() => resolve()));
});

function panelHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { cookie: `scmcp_panel=${cookieToken}`, "x-scmcp-csrf": "1", ...extra };
}

async function rpc(body: Json, sessionId?: string): Promise<{ status: number; json: Json; sessionId: string | null }> {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.security.localToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json: Json = {};
  try {
    json = JSON.parse(text) as Json;
  } catch {
    const match = /data: (\{.*\})/.exec(text);
    if (match?.[1]) json = JSON.parse(match[1]) as Json;
  }
  return { status: response.status, json, sessionId: response.headers.get("mcp-session-id") };
}

async function callTool(sessionId: string, name: string, args: Json = {}): Promise<Json> {
  const result = await rpc({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name, arguments: args } }, sessionId);
  assert.equal(result.status, 200, JSON.stringify(result.json));
  const resultValue = result.json.result as { content?: { text?: string }[]; isError?: boolean };
  assert.notEqual(resultValue?.isError, true, `tool ${name} failed: ${JSON.stringify(result.json)}`);
  const text = resultValue?.content?.[0]?.text ?? "{}";
  return JSON.parse(text) as Json;
}

test("fresh DATA_DIR bootstrap generates private secrets and a usable entry point", async () => {
  // Local-token comes from the env in tests; prove the file path separately.
  const dir = mkdtempSync(join(tmpdir(), "journey-fresh-"));
  const previousToken = process.env.MCP_LOCAL_TOKEN;
  const previousData = process.env.DATA_DIR;
  delete process.env.MCP_LOCAL_TOKEN;
  process.env.DATA_DIR = dir;
  try {
    const fresh = loadConfig();
    assert.ok(fresh.security.localToken.length >= 32);
    const tokenFile = statSync(join(dir, "local-token"));
    assert.equal(tokenFile.mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, "encryption.key")).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  } finally {
    if (previousToken === undefined) delete process.env.MCP_LOCAL_TOKEN;
    else process.env.MCP_LOCAL_TOKEN = previousToken;
    if (previousData === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousData;
  }
  const health = await fetch(`${base}/health`).then((response) => response.json() as Promise<Json>);
  assert.equal(health.status, "ok");
  assert.equal(typeof health.connections, "number");
  const login = await fetch(`${base}/panel/login`);
  assert.equal(login.status, 200);
  assert.match(await login.text(), /SoundCloud Studio/);
  const panel = await fetch(`${base}/panel`, { redirect: "manual", headers: panelHeaders() });
  assert.equal(panel.status, 200);
  assert.match(await panel.text(), /data-tab="upload"/);
});

test("legacy MCP client: read, upload, edit, playlist add/remove, delete", async () => {
  const init = await rpc({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "journey", version: "1" } },
  });
  assert.equal(init.status, 200, JSON.stringify(init.json));
  const sessionId = init.sessionId;
  assert.ok(sessionId, "session id");

  const me = await callTool(sessionId ?? "", "get_me");
  assert.equal((me as { username?: string }).username, "tester");
  const tracks = await callTool(sessionId ?? "", "list_my_tracks", { limit: 5 });
  assert.equal(((tracks as { items?: unknown[] }).items ?? []).length, 1);

  const uploaded = await callTool(sessionId ?? "", "upload_track", {
    file_path: tonePath,
    title: "Journey upload",
    sharing: "private",
    auto_tag: true,
    attach_artwork: true,
  });
  assert.equal((uploaded.track as Json).urn, "soundcloud:tracks:1003");
  assert.ok(scState.uploads >= 1);

  const updated = await callTool(sessionId ?? "", "update_track", {
    track_id: "soundcloud:tracks:1003", title: "Journey edited",
  });
  assert.equal((updated as Json).title, "Journey edited");
  assert.ok(scState.putTracks >= 1);

  const playlist = await callTool(sessionId ?? "", "create_playlist", {
    title: "Journey playlist", track_ids: ["soundcloud:tracks:1001"],
  });
  assert.equal((playlist as Json).urn, "soundcloud:playlists:2002");

  await callTool(sessionId ?? "", "add_tracks_to_playlist", {
    playlist_id: "soundcloud:playlists:2001", track_ids: ["soundcloud:tracks:1003"],
  });
  await callTool(sessionId ?? "", "remove_track_from_playlist", {
    playlist_id: "soundcloud:playlists:2001", track_id: "soundcloud:tracks:1003",
  });
  await callTool(sessionId ?? "", "delete_playlist", { playlist_id: "soundcloud:playlists:2002" });
  await callTool(sessionId ?? "", "delete_track", { track_id: "soundcloud:tracks:1003" });
  assert.ok(scState.deletes >= 2);
});

test("modern MCP client (2026-07-28): tools/call, resources/read, prompts/get", async () => {
  const meta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "journey", version: "1" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  const call = async (method: string, params: Json, name?: string): Promise<Json> => {
    const response = await fetch(`${base}/mcp-v2`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.security.localToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": method,
        ...(name ? { "mcp-name": name } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: meta } }),
    });
    assert.equal(response.status, 200, `${method} -> ${response.status} ${await response.clone().text()}`);
    return (await response.json()) as Json;
  };

  const me = await call("tools/call", { name: "get_me", arguments: {} }, "get_me");
  const payload = (me.result as { content?: { text?: string }[] })?.content?.[0]?.text ?? "{}";
  assert.equal((JSON.parse(payload) as Json).username, "tester");

  const resource = await call("resources/read", { uri: "soundcloud://guide" }, "soundcloud://guide");
  const contents = (resource.result as { contents?: { text?: string }[] })?.contents ?? [];
  assert.match(contents[0]?.text ?? "", /operating guide/);

  const prompt = await call("prompts/get", { name: "plan_upload", arguments: { file: "/music/a.mp3" } }, "plan_upload");
  const messages = (prompt.result as { messages?: { content?: { text?: string } }[] })?.messages ?? [];
  assert.match(messages[0]?.content?.text ?? "", /Upload plan for \/music\/a\.mp3/);
});

test("panel REST journey: state, upload, patch, playlists, social, export, web status", async () => {
  const state = await fetch(`${base}/api/state`, { headers: panelHeaders() });
  assert.equal(state.status, 200);
  const stateBody = (await state.json()) as Json;
  assert.equal((stateBody.me as Json).username, "tester");

  const form = new FormData();
  form.set("upload_id", "journey-1");
  form.set("metadata", JSON.stringify({ title: "Panel journey", sharing: "private", tags: "a,b" }));
  form.set("file", new Blob([Buffer.alloc(2048, 3)], { type: "audio/mpeg" }), "panel.mp3");
  const upload = await fetch(`${base}/api/upload`, { method: "POST", headers: panelHeaders(), body: form });
  assert.equal(upload.status, 201, await upload.clone().text());

  const patch = await fetch(`${base}/api/tracks/soundcloud:tracks:1003`, {
    method: "PATCH", headers: panelHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ title: "Panel edited", genre: "Electronic" }),
  });
  assert.equal(patch.status, 200);

  const playlist = await fetch(`${base}/api/playlists`, {
    method: "POST", headers: panelHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ title: "Panel playlist", sharing: "private" }),
  });
  assert.equal(playlist.status, 201);
  assert.equal(((await playlist.json()) as Json).urn, "soundcloud:playlists:2002");

  const add = await fetch(`${base}/api/playlists/soundcloud:playlists:2001/tracks`, {
    method: "POST", headers: panelHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ add: ["soundcloud:tracks:1003"] }),
  });
  assert.equal(add.status, 200);

  const like = await fetch(`${base}/api/social/like`, {
    method: "POST", headers: panelHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ kind: "track", urn: "soundcloud:tracks:1001", action: "like" }),
  });
  assert.equal(like.status, 200);

  const exported = await fetch(`${base}/api/export`, { headers: panelHeaders() });
  assert.equal(exported.status, 200);
  assert.equal(((await exported.json()) as Json).exported_at !== undefined, true);

  const web = await fetch(`${base}/api/web/status`, { headers: panelHeaders() });
  assert.equal(web.status, 200);
  assert.equal(typeof ((await web.json()) as Json).cookie_file, "object");

  const noCsrf = await fetch(`${base}/api/tracks/soundcloud:tracks:1001`, {
    method: "DELETE", headers: { cookie: `scmcp_panel=${cookieToken}` },
  });
  assert.equal(noCsrf.status, 403);
});

test("CLI: chrome cookie export and doctor (valid + corrupt)", () => {
  const dir = mkdtempSync(join(tmpdir(), "journey-cli-"));
  const dbPath = join(dir, "Cookies");
  const outPath = join(dir, "cookies.json");
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const jwt = (claims: Json): string =>
    `${Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

  const key = pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1");
  const seal = (value: string, host: string): Buffer => {
    const plain = Buffer.concat([createHash("sha256").update(host).digest(), Buffer.from(value)]);
    const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    return Buffer.concat([Buffer.from("v10", "latin1"), cipher.update(plain), cipher.final()]);
  };

  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE cookies (
    host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT,
    expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER
  )`);
  const insert = db.prepare("INSERT INTO cookies VALUES (?,?,?,?,?,?,?,?,?)");
  for (const name of ["oauth_token", "oauth_refresh_token", "sc_session", "datadome"]) {
    const value = name === "oauth_token" ? jwt({ exp, client_id: "web-client" }) : `${name}-value`;
    insert.run(name === "datadome" ? ".soundcloud.com" : "soundcloud.com", name, "", seal(value, name === "datadome" ? ".soundcloud.com" : "soundcloud.com"), "/", 0, 1, 1, -1);
  }
  db.close();

  const cookies = spawnSync(process.execPath, ["--import", "tsx", "src/web/cli.ts", "cookies", "--db", dbPath, "--out", outPath, "--json"], {
    encoding: "utf8",
    env: { ...process.env, SC_ALLOW_COOKIES_IN_REPO: "1" },
  });
  assert.equal(cookies.status, 0, cookies.stderr);
  const exported = JSON.parse(cookies.stdout) as { cookies: number; names: string[]; tokenExpiresAt: string };
  assert.equal(exported.cookies, 4);
  assert.ok(exported.names.includes("oauth_token"));
  assert.equal(statSync(outPath).mode & 0o777, 0o600);

  const doctor = spawnSync(process.execPath, ["--import", "tsx", "src/web/cli.ts", "doctor", "--cookie-file", outPath, "--chrome", process.execPath, "--json"], { encoding: "utf8" });
  assert.equal(doctor.status, 0, doctor.stderr);
  const status = JSON.parse(doctor.stdout) as { ok: boolean; warnings: string[] };
  assert.equal(status.ok, true, JSON.stringify(status));

  writeFileSync(outPath, "{broken", { mode: 0o600 });
  const corrupt = spawnSync(process.execPath, ["--import", "tsx", "src/web/cli.ts", "doctor", "--cookie-file", outPath, "--chrome", process.execPath, "--json"], { encoding: "utf8" });
  assert.equal(corrupt.status, 1);
  assert.match(corrupt.stdout, /not valid JSON/);
});

test("operator CLI talks to the running server", async () => {
  // Async spawn: spawnSync would block the event loop that must answer the CLI.
  const env = { ...process.env, SC_MCP_URL: base, SC_MCP_TOKEN: config.security.localToken, DATA_DIR: config.dataDir };
  const tracks = await execFileAsync(process.execPath, ["scripts/sc.mjs", "tracks", "--limit", "5"], { encoding: "utf8", env, timeout: 15_000 });
  assert.equal(((JSON.parse(tracks.stdout) as { items: unknown[] }).items ?? []).length, 1);

  const health = await execFileAsync(process.execPath, ["scripts/sc.mjs", "status"], { encoding: "utf8", env, timeout: 15_000 });
  assert.equal((JSON.parse(health.stdout) as Json).status, "ok");
});

test("installer --dry-run changes nothing and exits 0", () => {
  const envBefore = existsSync(".env");
  const result = spawnSync("bash", ["install-termux.sh", "--dry-run"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[dry-run\] npm ci/);
  assert.match(result.stdout, /Dry run complete/);
  assert.equal(existsSync(".env"), envBefore);
});

test("user-visible failure paths return actionable errors", async () => {
  const unauthorized = await fetch(`${base}/api/state`);
  assert.equal(unauthorized.status, 401);
  const noToken = await fetch(`${base}/mcp`, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } }),
  });
  assert.equal(noToken.status, 401);
  assert.match(noToken.headers.get("www-authenticate") ?? "", /resource_metadata/);
});
