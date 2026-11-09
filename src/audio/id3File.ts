/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Atomic ID3v2.4 editing for MP3 files. The audio payload is streamed from its
 * original offset to the destination, so a 500 MB file is never loaded into
 * memory. A `.bak` copy is created for in-place edits by default.
 */

import { createReadStream, createWriteStream } from "node:fs";
import { chmod, copyFile, open, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { pipeline } from "node:stream/promises";
import {
  applyId3Edits,
  buildId3v24,
  decodeSyncSafe,
  parseId3,
  parseId3Document,
  type Id3Document,
  type Id3Edits,
  type Id3Tags,
} from "../soundcloud/id3.js";
import { AppError } from "../errors.js";

const MAX_TAG_BYTES = 64 * 1024 * 1024;
const ID3V1_BYTES = 128;

export interface ArtworkInput {
  mimeType: string;
  data: Buffer;
  description?: string;
}

export interface WriteTagsOptions {
  path: string;
  edits: Id3Edits;
  artwork?: ArtworkInput | null;
  removeArtwork?: boolean;
  outputPath?: string;
  backup?: boolean;
}

export interface WriteTagsResult {
  path: string;
  tags: Id3Tags;
  tagBytes: number;
  audioBytes: number;
  backupPath?: string;
}

export interface ReadTagsResult {
  tags: Id3Tags;
  document: Id3Document;
  size: number;
}

export async function readTagsFromFile(path: string): Promise<ReadTagsResult> {
  const info = await stat(path);
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(10);
    const headerRead = await handle.read(header, 0, 10, 0);
    if (headerRead.bytesRead < 10 || header.subarray(0, 3).toString("latin1") !== "ID3") {
      const empty = Buffer.alloc(0);
      return {
        tags: { warnings: ["No ID3v2 tag"] },
        document: parseId3Document(empty),
        size: info.size,
      };
    }

    const declared = decodeSyncSafe(header, 6);
    const flags = header[5] ?? 0;
    const tagLength = Math.min(MAX_TAG_BYTES, 10 + declared + ((flags & 0x10) !== 0 ? 10 : 0));
    const tag = Buffer.alloc(tagLength);
    await handle.read(tag, 0, tagLength, 0);
    const document = parseId3Document(tag);
    const tags = parseId3(tag);
    return { tags, document, size: info.size };
  } finally {
    await handle.close();
  }
}

export async function writeTags(options: WriteTagsOptions): Promise<WriteTagsResult> {
  const source = options.path;
  const info = await stat(source);
  if (!info.isFile()) throw new AppError("BAD_REQUEST", `${source} is not a regular file.`, { status: 400 });

  const handle = await open(source, "r");
  let document: Id3Document;
  let audioOffset = 0;
  try {
    const header = Buffer.alloc(10);
    const headerRead = await handle.read(header, 0, 10, 0);
    if (headerRead.bytesRead >= 10 && header.subarray(0, 3).toString("latin1") === "ID3") {
      const declared = decodeSyncSafe(header, 6);
      const flags = header[5] ?? 0;
      const tagLength = Math.min(MAX_TAG_BYTES, 10 + declared + ((flags & 0x10) !== 0 ? 10 : 0));
      if (tagLength > info.size) {
        throw new AppError("INVALID_RESPONSE", "ID3 tag size exceeds file size.", { status: 422 });
      }
      const tag = Buffer.alloc(tagLength);
      await handle.read(tag, 0, tagLength, 0);
      document = parseId3Document(tag);
      audioOffset = Math.min(tagLength, info.size);
    } else {
      document = { major: 0, version: "none", frames: [], audioOffset: 0, warnings: [] };
      audioOffset = 0;
    }
  } finally {
    await handle.close();
  }

  const frames = applyId3Edits(document, options.edits, options.artwork, options.removeArtwork === true);
  const tag = buildId3v24(frames, 2048);

  const destination = options.outputPath ?? source;
  const inPlace = destination === source;

  // Exclude a stale ID3v1 trailer so old players do not override the v2 tag.
  let audioEnd = info.size;
  if (audioOffset + ID3V1_BYTES <= info.size) {
    const trailerHandle = await open(source, "r");
    try {
      const trailer = Buffer.alloc(3);
      await trailerHandle.read(trailer, 0, 3, info.size - ID3V1_BYTES);
      if (trailer.toString("latin1") === "TAG") audioEnd = info.size - ID3V1_BYTES;
    } finally {
      await trailerHandle.close();
    }
  }
  const audioBytes = Math.max(0, audioEnd - audioOffset);

  let backupPath: string | undefined;
  if (inPlace && options.backup !== false) {
    backupPath = `${source}.bak`;
    try {
      await copyFile(source, backupPath);
      await chmod(backupPath, info.mode & 0o777);
    } catch (error) {
      throw new AppError("INTERNAL", `Could not create ID3 backup: ${(error as Error).message}`, {
        status: 500,
      });
    }
  }

  const temp = join(dirname(destination), `.${basename(destination)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    const out = createWriteStream(temp, { mode: info.mode & 0o777 });
    await new Promise<void>((resolve, reject) => {
      out.once("open", () => resolve());
      out.once("error", reject);
    });
    await new Promise<void>((resolve, reject) => {
      out.write(tag, (error) => (error ? reject(error) : resolve()));
    });
    if (audioBytes > 0) {
      await pipeline(createReadStream(source, { start: audioOffset, end: audioEnd - 1 }), out, {
        end: false,
      });
    }
    await new Promise<void>((resolve, reject) => {
      out.end((error?: Error | null) => (error ? reject(error) : resolve()));
    });
    await chmod(temp, info.mode & 0o777);
    await rename(temp, destination);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error instanceof AppError
      ? error
      : new AppError("INTERNAL", `ID3 write failed: ${(error as Error).message}`, { status: 500 });
  }

  const tags = parseId3(tag);
  return {
    path: destination,
    tags,
    tagBytes: tag.length,
    audioBytes,
    ...(backupPath ? { backupPath } : {}),
  };
}

export function inferArtworkMime(path: string): string {
  const extension = path.toLowerCase().split(".").pop();
  switch (extension) {
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return "image/jpeg";
  }
}
