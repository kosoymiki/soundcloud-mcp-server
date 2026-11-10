/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { AudioService } from "../src/audio/service.js";
import { UploadService } from "../src/uploads/service.js";
import { EventBus } from "../src/events.js";
import { createLogger } from "../src/logger.js";
import { readTagsFromFile, writeTags } from "../src/audio/id3File.js";
import { parseId3, parseId3Document, makeTextFrame, buildId3v24, applyId3Edits, type Id3Frame } from "../src/soundcloud/id3.js";
import { testConfig } from "./helpers.js";

const exec = promisify(execFile);

function hasFfmpeg(binary: string): boolean {
  try {
    // execFile is async and never throws synchronously on ENOENT; probe must be sync.
    execFileSync(binary, ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("ID3 writer preserves unknown frames and replaces edited ones", () => {
  const original = buildId3v24([
    makeTextFrame("TIT2", "Old title"),
    makeTextFrame("TPE1", "Old artist"),
    { id: "PRIV", flags: 0, data: Buffer.from("owner\0private-data", "latin1") } as Id3Frame,
  ]);
  const document = parseId3Document(original);
  const frames = applyId3Edits(
    document,
    { title: "New title", album: "Album", year: "2026", bpm: "140", isrc: "US-ABC-26-00001" },
    { mimeType: "image/jpeg", data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) },
    false
  );
  const rebuilt = buildId3v24(frames);
  const tags = parseId3(rebuilt);
  assert.equal(tags.title, "New title");
  assert.equal(tags.artist, "Old artist", "fields not present in the edit are preserved");
  assert.equal(tags.album, "Album");
  assert.equal(tags.year, "2026");
  assert.equal(tags.bpm, "140");
  assert.equal(tags.isrc, "US-ABC-26-00001");
  assert.equal(tags.artwork?.mimeType, "image/jpeg");
  assert.ok(frames.some((frame) => frame.id === "PRIV"), "unknown frames must survive an edit");
});

test("MP3 tag and audio processing integration", { skip: !hasFfmpeg("ffmpeg") }, async (t) => {
  const config = testConfig();
  const root = config.dataDir;
  const input = join(root, "tone.mp3");
  const artwork = join(root, "art.png");
  await exec(config.audio.ffmpegPath, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=1.4",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "128k",
    input,
  ]);
  await exec(config.audio.ffmpegPath, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=64x64",
    "-frames:v",
    "1",
    artwork,
  ]);

  const audio = new AudioService(config, createLogger("error"), new EventBus(), new UploadService(
    config,
    createLogger("error"),
    new EventBus(),
    {} as never
  ));

  const probe = await audio.probe(input);
  assert.ok(probe.duration_seconds > 1.2 && probe.duration_seconds < 1.6);
  assert.equal(probe.codec, "mp3");

  const written = await audio.updateTags({
    filePath: input,
    edits: {
      title: "Tone",
      artist: "Unit Test",
      album: "Audio Lab",
      genre: "Test",
      year: "2026",
      track: "1/2",
      bpm: "140",
      isrc: "US-ABC-26-00001",
      comment: "hello",
      lyrics: "la la",
    },
    artworkPath: artwork,
  });
  assert.ok(written.backup_path && existsSync(written.backup_path));
  const tagRead = await readTagsFromFile(input);
  assert.equal(tagRead.tags.title, "Tone");
  assert.equal(tagRead.tags.artist, "Unit Test");
  assert.equal(tagRead.tags.albumArtist, undefined);
  assert.equal(tagRead.tags.bpm, "140");
  assert.equal(tagRead.tags.isrc, "US-ABC-26-00001");
  assert.equal(tagRead.tags.comment, "hello");
  assert.equal(tagRead.tags.artwork?.mimeType, "image/png");
  assert.ok(statSync(input).size > 0);

  const tempo = await audio.process({ filePath: input, operation: "tempo", ratio: 1.5 });
  assert.ok(existsSync(tempo.output_path));
  assert.ok(
    Math.abs(tempo.output.duration_seconds - probe.duration_seconds / 1.5) < 0.2,
    `tempo duration ${tempo.output.duration_seconds}`
  );
  const tempoTags = await readTagsFromFile(tempo.output_path);
  assert.equal(tempoTags.tags.title, "Tone", "tags are preserved through speed change");
  assert.ok(tempoTags.tags.artwork, "artwork is preserved through speed change");

  const trimmed = await audio.process({
    filePath: input,
    operation: "trim",
    startSeconds: 0.2,
    endSeconds: 0.8,
  });
  assert.ok(Math.abs(trimmed.output.duration_seconds - 0.6) < 0.15);

  const normalized = await audio.process({ filePath: input, operation: "normalize", targetLufs: -14 });
  assert.ok(existsSync(normalized.output_path));

  const converted = await audio.process({ filePath: input, operation: "convert", format: "wav" });
  assert.match(converted.output.container, /wav/);
  assert.equal(converted.output.codec, "pcm_s16le");

  const copy = join(root, "copy.mp3");
  const copied = await writeTags({
    path: input,
    outputPath: copy,
    edits: { title: "Copy" },
    backup: false,
  });
  assert.equal(copied.path, copy);
  const copiedTags = parseId3(readFileSync(copy));
  assert.equal(copiedTags.title, "Copy");
  assert.equal(copiedTags.artist, "Unit Test");
});
