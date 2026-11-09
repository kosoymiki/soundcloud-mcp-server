/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { AppError } from "../errors.js";
import { WebActionSession } from "./actions.js";
import { mimeForFile, WebUploader } from "./upload.js";

interface ParsedArgs {
  command: string;
  flags: Map<string, string>;
  positionals: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "upload", ...rest] = argv;
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] as string;
    if (token.startsWith("--")) {
      const [rawKey, inline] = token.slice(2).split("=", 2);
      const key = rawKey ?? "";
      if (inline !== undefined) {
        flags.set(key, inline);
      } else {
        const next = rest[index + 1];
        if (next && !next.startsWith("--")) {
          flags.set(key, next);
          index += 1;
        } else {
          flags.set(key, "true");
        }
      }
    } else {
      positionals.push(token);
    }
  }
  return { command, flags, positionals };
}

function probeDurationSeconds(filePath: string): number | undefined {
  try {
    const ffprobe = process.env.FFPROBE_PATH ?? "ffprobe";
    const output = execFileSync(
      ffprobe,
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath],
      { encoding: "utf8", timeout: 20_000 }
    ).trim();
    const value = Number(output);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function usage(): string {
  return [
    "Usage:",
    "  web-upload upload --file <path> [--title <title>] [--artist <artist>] [--genre <genre>]",
    "                 [--tags a,b] [--permalink <slug>] [--album <album title>] [--album-urn <urn>]",
    "                 [--album-type ALBUM|EP] [--license <license>] [--public|--private] [--verify]",
    "  web-upload album --title <title> --tracks <urn[,urn]> [--genre <genre>] [--ep]",
    "  web-upload actions",
  ].join("\n");
}

async function main(): Promise<void> {
  const { command, flags, positionals } = parseArgs(process.argv.slice(2));
  if (flags.has("help") || command === "help" || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }
  if (!["actions", "album", "upload"].includes(command)) {
    console.log(usage());
    process.exitCode = 2;
    return;
  }
  if (command === "album" && (!flags.get("title") || !flags.get("tracks"))) {
    console.error("album requires --title and --tracks <urn,...>");
    process.exitCode = 2;
    return;
  }
  if (command === "upload" && !(flags.get("file") ?? positionals[0])) {
    console.error("upload requires --file <path>");
    process.exitCode = 2;
    return;
  }
  const session = new WebActionSession({
    logger: (level, message) => {
      if (level !== "debug" || process.env.SC_WEB_VERBOSE === "1") console.error(`[web:${level}] ${message}`);
    },
  });
  await session.start();
  try {
    if (command === "actions") {
      const discovered = await session.discoverActions();
      const sorted = [...discovered.actions.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      console.log(JSON.stringify({ chunks: discovered.chunkCount, actions: Object.fromEntries(sorted) }, null, 2));
      return;
    }
    if (command === "album") {
      const title = flags.get("title");
      const urnsRaw = flags.get("tracks");
      if (!title || !urnsRaw) throw new AppError("BAD_REQUEST", "album requires --title and --tracks <urn,...>", { status: 400 });
      const uploader = new WebUploader(session);
      const album = await uploader.createAlbum({
        title,
        trackUrns: urnsRaw.split(",").map((urn) => urn.trim()).filter(Boolean),
        ...(flags.get("genre") ? { genre: flags.get("genre") as string } : {}),
        ...(flags.has("ep") ? { type: "EP" as const } : {}),
      });
      console.log(JSON.stringify({ album }, null, 2));
      return;
    }
    if (command !== "upload") throw new AppError("BAD_REQUEST", `Unknown command: ${command}\n${usage()}`, { status: 400 });
    const filePath = flags.get("file") ?? positionals[0];
    if (!filePath) throw new AppError("BAD_REQUEST", "upload requires --file <path>", { status: 400 });
    mimeForFile(filePath);
    const durationSeconds = probeDurationSeconds(filePath);
    const uploader = new WebUploader(session);
    const result = await uploader.upload({
      filePath,
      title: flags.get("title") ?? basename(filePath).replace(/\.[^.]+$/, ""),
      ...(flags.get("artist") ? { artist: flags.get("artist") as string } : {}),
      ...(flags.get("genre") ? { genre: flags.get("genre") as string } : {}),
      ...(flags.get("tags") ? { tags: (flags.get("tags") as string).split(",").map((tag) => tag.trim()).filter(Boolean) } : {}),
      ...(flags.get("permalink") ? { permalink: flags.get("permalink") as string } : {}),
      ...(flags.get("license") ? { license: flags.get("license") as string } : {}),
      ...(flags.has("private") ? { shareAccess: "PRIVATE" as const } : {}),
      ...(durationSeconds ? { durationSeconds } : {}),
      ...(flags.get("album") ? { albumTitle: flags.get("album") as string } : {}),
      ...(flags.get("album-urn") ? { albumUrn: flags.get("album-urn") as string } : {}),
      ...(flags.get("album-type") === "EP" ? { albumType: "EP" as const } : {}),
    });
    const summary: Record<string, unknown> = {
      uid: result.uid,
      bytes: result.upload.bytes,
      s3_status: result.upload.status,
      s3_etag: result.upload.etag,
      track: result.track,
      ...(result.album !== undefined ? { album: result.album } : {}),
    };
    if (flags.has("verify")) {
      try {
        const permalink = flags.get("permalink") ?? flags.get("title");
        if (permalink) summary.verified = await uploader.verifyPermalink(permalink);
      } catch (error) {
        summary.verify_error = error instanceof Error ? error.message : String(error);
      }
    }
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await session.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`error: ${message}`);
  if (error instanceof AppError && error.options.details !== undefined) console.error(JSON.stringify(error.options.details, null, 2));
  process.exitCode = 1;
});
