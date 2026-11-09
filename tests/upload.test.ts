/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UploadService } from "../src/uploads/service.js";
import { EventBus } from "../src/events.js";
import { createLogger } from "../src/logger.js";
import { AppError } from "../src/errors.js";
import type { SoundCloudApi } from "../src/soundcloud/api.js";
import { parseId3 } from "../src/soundcloud/id3.js";
import { testConfig } from "./helpers.js";

function syncsafe(value: number): Buffer {
  return Buffer.from([(value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f]);
}

function frame(id: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(10);
  header.write(id, 0, "latin1");
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function makeMp3(path: string): Buffer {
  const text = (value: string): Buffer => Buffer.concat([Buffer.from([3]), Buffer.from(value, "utf8")]);
  const artwork = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const apic = Buffer.concat([
    Buffer.from([0]),
    Buffer.from("image/jpeg\0", "latin1"),
    Buffer.from([3, 0]),
    artwork,
  ]);
  const frames = Buffer.concat([
    frame("TIT2", text("ID3 Title")),
    frame("TPE1", text("ID3 Artist")),
    frame("TCON", text("Rap")),
    frame("APIC", apic),
  ]);
  const header = Buffer.concat([Buffer.from("ID3", "latin1"), Buffer.from([3, 0, 0]), syncsafe(frames.length)]);
  const bytes = Buffer.concat([header, frames, Buffer.alloc(1024, 0)]);
  writeFileSync(path, bytes);
  return bytes;
}

interface Recorded {
  metadata: Record<string, unknown>;
  file: { size: number; filename: string };
  artwork: boolean;
  progress: number[];
}

function fakeApi(record: Recorded): SoundCloudApi {
  return {
    uploadTrack: async (metadata: Record<string, unknown>, file: { size: number; filename: string }, options: { onProgress?: (sent: number, total: number) => void }) => {
      record.metadata = metadata;
      record.file = { size: file.size, filename: file.filename };
      options.onProgress?.(file.size / 2, file.size);
      options.onProgress?.(file.size, file.size);
      return { kind: "track", id: 1, urn: "soundcloud:tracks:1", title: metadata.title, permalink_url: "https://soundcloud.com/x/y" };
    },
    uploadArtwork: async () => {
      record.artwork = true;
      return { kind: "track", id: 1, urn: "soundcloud:tracks:1", title: "ID3 Title" };
    },
  } as unknown as SoundCloudApi;
}

test("upload auto-fills metadata from ID3 and attaches embedded artwork", async () => {
  const config = testConfig();
  const path = join(config.dataDir, "song.mp3");
  makeMp3(path);
  const record: Recorded = { metadata: {}, file: { size: 0, filename: "" }, artwork: false, progress: [] };
  const service = new UploadService(config, createLogger("error"), new EventBus(), fakeApi(record));

  const result = await service.upload({
    filePath: path,
    metadata: { sharing: "private" },
    onProgress: (sent) => record.progress.push(sent),
  });

  assert.equal(result.metadata.title, "ID3 Title");
  assert.equal(result.metadata.artist, "ID3 Artist");
  assert.equal(result.metadata.genre, "Rap");
  assert.equal(record.file.filename, "song.mp3");
  assert.ok(record.file.size > 0);
  assert.equal(record.artwork, true);
  assert.deepEqual(record.progress, [record.file.size / 2, record.file.size]);
  assert.equal(result.track.urn, "soundcloud:tracks:1");
});

test("explicit metadata wins over ID3", async () => {
  const config = testConfig();
  const path = join(config.dataDir, "song.mp3");
  makeMp3(path);
  const record: Recorded = { metadata: {}, file: { size: 0, filename: "" }, artwork: false, progress: [] };
  const service = new UploadService(config, createLogger("error"), new EventBus(), fakeApi(record));
  await service.upload({
    filePath: path,
    metadata: { title: "Override", artist: "Override Artist", genre: "Trap", sharing: "public" },
    autoTag: false,
  });
  assert.equal(record.metadata.title, "Override");
  assert.equal(record.metadata.artist, "Override Artist");
  assert.equal(record.metadata.genre, "Trap");
  assert.equal(record.metadata.sharing, "public");
});

test("files outside media roots are rejected", async () => {
  const config = testConfig();
  const outsideDir = mkdtempSync(join(tmpdir(), "scmcp-outside-"));
  const outside = join(outsideDir, "secret.mp3");
  writeFileSync(outside, Buffer.from("x"));
  const record: Recorded = { metadata: {}, file: { size: 0, filename: "" }, artwork: false, progress: [] };
  const service = new UploadService(config, createLogger("error"), new EventBus(), fakeApi(record));

  await assert.rejects(
    () => service.upload({ filePath: outside, metadata: {} }),
    (error: unknown) => error instanceof AppError && error.code === "FORBIDDEN"
  );
});

test("unsupported extensions and oversize files are rejected with typed errors", async () => {
  const config = testConfig();
  const textPath = join(config.dataDir, "notes.txt");
  writeFileSync(textPath, "hello");
  const record: Recorded = { metadata: {}, file: { size: 0, filename: "" }, artwork: false, progress: [] };
  const service = new UploadService(config, createLogger("error"), new EventBus(), fakeApi(record));

  await assert.throws(
    () => service.resolvePath(textPath, "audio"),
    (error: unknown) => error instanceof AppError && error.code === "UNSUPPORTED_MEDIA"
  );

  const audioPath = join(config.dataDir, "big.mp3");
  writeFileSync(audioPath, Buffer.alloc(64));
  config.sc.maxUploadBytes = 32;
  await assert.throws(
    () => service.resolvePath(audioPath, "audio"),
    (error: unknown) => error instanceof AppError && error.code === "UPLOAD_TOO_LARGE"
  );
});

test("ID3 parser reads the generated fixture", () => {
  const config = testConfig();
  const path = join(config.dataDir, "fixture.mp3");
  makeMp3(path);
  const tags = parseId3(readFileSync(path));
  assert.equal(tags.title, "ID3 Title");
});
