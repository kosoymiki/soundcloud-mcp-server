/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import Busboy from "busboy";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { testConfig, freePort, seedLocalConnection, startApp } from "./helpers.js";

const exec = promisify(execFile);

function hasFfmpeg(binary: string): boolean {
  try {
    // Async execFile never throws on ENOENT synchronously; this check must be sync.
    execFileSync(binary, ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

interface FakeState {
  upload: { fields: Record<string, string>; fileBytes: number; fileName: string } | null;
  updatedTrack: Record<string, unknown> | null;
}

function startFakeSoundCloud(port: number, state: FakeState): Promise<Server> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json({ limit: "5mb" }));

    app.get("/me", (_req, res) => {
      res.json({
        kind: "user",
        id: 7,
        urn: "soundcloud:users:7",
        username: "mc-test",
        permalink_url: "https://soundcloud.com/mc-test",
        plan: "Artist",
        track_count: 2,
        playlist_count: 1,
        followers_count: 9,
        quota: { unlimited_upload_quota: false, upload_seconds_used: 3600, upload_seconds_left: 7200 },
        upload_seconds_left: 7200,
      });
    });
    app.get("/me/tracks", (_req, res) => {
      res.json({
        collection: [{ kind: "track", id: 1, urn: "soundcloud:tracks:1", title: "One", duration: 60_000 }],
        next_href: null,
      });
    });
    app.get("/me/playlists", (_req, res) => {
      res.json({
        collection: [{ kind: "playlist", id: 2, urn: "soundcloud:playlists:2", title: "Set", track_count: 1 }],
        next_href: null,
      });
    });
    app.get("/me/likes/tracks", (_req, res) => res.json({ collection: [], next_href: null }));
    app.get("/me/followers", (_req, res) => res.json({ collection: [], next_href: null }));
    app.get("/me/followings", (_req, res) => res.json({ collection: [], next_href: null }));

    app.post("/tracks", (req, res) => {
      const busboy = Busboy({ headers: req.headers });
      const fields: Record<string, string> = {};
      let fileBytes = 0;
      let fileName = "";
      busboy.on("field", (name, value) => {
        fields[name] = value;
      });
      busboy.on("file", (_name, stream, info) => {
        fileName = info.filename;
        stream.on("data", (chunk: Buffer) => {
          fileBytes += chunk.length;
        });
      });
      busboy.on("close", () => {
        state.upload = { fields, fileBytes, fileName };
        res.status(201).json({ kind: "track", id: 10, urn: "soundcloud:tracks:10", title: fields["track[title]"] });
      });
      req.pipe(busboy);
    });

    app.put("/tracks/:urn", (req, res) => {
      state.updatedTrack = req.body;
      res.json({ kind: "track", id: 1, urn: req.params.urn, title: req.body?.track?.title });
    });

    const server = app.listen(port, "127.0.0.1", () => resolve(server));
  });
}

test("panel API reads state, streams an upload and patches a track", async () => {
  const scPort = await freePort();
  const appPort = await freePort();
  const fakeState: FakeState = { upload: null, updatedTrack: null };
  const fakeSc = await startFakeSoundCloud(scPort, fakeState);
  const config = testConfig({ mode: "local", port: appPort, publicUrl: `http://127.0.0.1:${appPort}` });
  config.sc.apiBase = `http://127.0.0.1:${scPort}`;
  config.security.panelAutoLogin = false;
  seedLocalConnection(config, "sc-access-token").dispose();
  const tonePath = join(config.dataDir, "tone.mp3");
  const canRunAudio = hasFfmpeg(config.audio.ffmpegPath);
  if (canRunAudio) {
    await exec(config.audio.ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=330:duration=1",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "128k",
      tonePath,
    ]);
  }
  const app = await startApp(config);
  const base = `http://127.0.0.1:${appPort}`;
  const token = config.security.localToken;

  try {
    const unauthorized = await fetch(`${base}/api/state`);
    assert.equal(unauthorized.status, 401);

    const stateResponse = await fetch(`${base}/api/state`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(stateResponse.status, 200);
    const state = (await stateResponse.json()) as {
      me: { username: string };
      tracks: { items: Array<{ title: string }> };
      quota: { secondsLeft: number };
    };
    assert.equal(state.me.username, "mc-test");
    assert.equal(state.tracks.items[0]?.title, "One");
    assert.equal(state.quota.secondsLeft, 7200);

    const webStatus = await fetch(`${base}/api/web/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(webStatus.status, 200);
    const web = (await webStatus.json()) as {
      ok: boolean;
      cookie_file: { path: string; exists: boolean; cookies: number };
      token: { present: boolean };
      chrome: { path: string };
    };
    assert.equal(typeof web.cookie_file.path, "string");
    assert.equal(typeof web.cookie_file.exists, "boolean");
    assert.equal(Array.isArray(web.warnings), true);

    const bytes = Buffer.alloc(2048, 7);
    const form = new FormData();
    form.set("upload_id", "panel-upload-1");
    form.set("metadata", JSON.stringify({ title: "Panel Track", artist: "MC Test", sharing: "private" }));
    form.set("file", new Blob([bytes], { type: "audio/mpeg" }), "panel.mp3");
    const upload = await fetch(`${base}/api/upload`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
    assert.equal(upload.status, 201);
    const uploadBody = (await upload.json()) as { track: { urn: string; title: string } };
    assert.equal(uploadBody.track.title, "Panel Track");
    assert.equal(fakeState.upload?.fields["track[title]"], "Panel Track");
    assert.equal(fakeState.upload?.fields["track[artist]"], "MC Test");
    assert.equal(fakeState.upload?.fileBytes, bytes.length);
    assert.equal(fakeState.upload?.fileName, "panel.mp3");

    const patch = await fetch(`${base}/api/tracks/soundcloud:tracks:1`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed", sharing: "public" }),
    });
    assert.equal(patch.status, 200);
    assert.equal((fakeState.updatedTrack as { track: { title: string } }).track.title, "Renamed");

    const exportResponse = await fetch(`${base}/api/export`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(exportResponse.status, 200);
    assert.match(exportResponse.headers.get("content-disposition") ?? "", /soundcloud-export/);

    if (canRunAudio) {
      const probe = await fetch(`${base}/api/audio/probe`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ file_path: tonePath }),
      });
      assert.equal(probe.status, 200);
      const probeBody = (await probe.json()) as { duration_seconds: number; codec: string };
      assert.equal(probeBody.codec, "mp3");
      assert.ok(probeBody.duration_seconds > 0.8 && probeBody.duration_seconds < 1.2);

      const tagEdit = await fetch(`${base}/api/audio/tags`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ file_path: tonePath, tags: { title: "Panel Tag", artist: "MC Test", bpm: "140" } }),
      });
      assert.equal(tagEdit.status, 200);
      const tagBody = (await tagEdit.json()) as { tags: { title: string; bpm: string } };
      assert.equal(tagBody.tags.title, "Panel Tag");
      assert.equal(tagBody.tags.bpm, "140");

      const speed = await fetch(`${base}/api/audio/process`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ file_path: tonePath, operation: "tempo", ratio: 1.25 }),
      });
      assert.equal(speed.status, 200);
      const speedBody = (await speed.json()) as { output_path: string };
      assert.ok(existsSync(speedBody.output_path));
      assert.ok(speedBody.output_path.includes("tempo1.25"));
    }
  } finally {
    await app.close();
    await new Promise<void>((resolve) => fakeSc.close(() => resolve()));
  }
});
