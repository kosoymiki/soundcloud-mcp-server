/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdir, readFile, stat } from "node:fs/promises";
import { statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve as resolvePath, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { EventBus } from "../events.js";
import type { UploadService } from "../uploads/service.js";
import { AppError } from "../errors.js";
import { Semaphore } from "../util/semaphore.js";
import {
  inferArtworkMime,
  readTagsFromFile,
  writeTags as writeId3Tags,
  type ArtworkInput,
} from "./id3File.js";
import { listFilters, probeMedia, runFfmpeg, type ProbeResult } from "./ffmpeg.js";
import type { Id3Edits, Id3Tags } from "../soundcloud/id3.js";

export type AudioOperation = "tempo" | "pitch" | "speed" | "both" | "normalize" | "trim" | "convert";
export type SpeedAlgorithm = "auto" | "rubberband" | "atempo";

export interface AudioInfo {
  path: string;
  size: number;
  duration_seconds: number;
  bitrate: number | null;
  sample_rate: number | null;
  channels: number | null;
  codec: string;
  container: string;
  tags: Id3Tags;
}

export interface ProcessRequest {
  filePath: string;
  operation: AudioOperation;
  ratio?: number;
  pitch?: number;
  algorithm?: SpeedAlgorithm;
  targetLufs?: number;
  truePeak?: number;
  lra?: number;
  startSeconds?: number;
  endSeconds?: number;
  format?: "mp3" | "wav" | "flac";
  bitrateKbps?: number;
  outputPath?: string;
  overwrite?: boolean;
  keepTags?: boolean;
  tagEdits?: Id3Edits;
  artworkPath?: string;
  removeArtwork?: boolean;
  signal?: AbortSignal;
  onProgress?: (elapsedSeconds: number, percent: number) => void;
}

export interface ProcessResult {
  operation: AudioOperation;
  input: AudioInfo;
  output: AudioInfo;
  output_path: string;
  elapsed_ms: number;
  warnings: string[];
}

export interface UpdateTagsRequest {
  filePath: string;
  edits: Id3Edits;
  artworkPath?: string;
  removeArtwork?: boolean;
  outputPath?: string;
  backup?: boolean;
}

const MAX_ARTWORK_BYTES = 20 * 1024 * 1024;
const MIN_RATIO = 0.25;
const MAX_RATIO = 4;

function clampRatio(value: number | undefined, fallback = 1): number {
  const ratio = value ?? fallback;
  if (!Number.isFinite(ratio) || ratio < MIN_RATIO || ratio > MAX_RATIO) {
    throw new AppError("BAD_REQUEST", `Ratio must be between ${MIN_RATIO} and ${MAX_RATIO}.`, {
      status: 400,
    });
  }
  return Math.round(ratio * 1000) / 1000;
}

function isWithin(root: string, candidate: string): boolean {
  const normalized = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate === root || candidate.startsWith(normalized);
}

function tagsToEdits(tags: Id3Tags): Id3Edits {
  return {
    ...(tags.title ? { title: tags.title } : {}),
    ...(tags.artist ? { artist: tags.artist } : {}),
    ...(tags.album ? { album: tags.album } : {}),
    ...(tags.albumArtist ? { albumArtist: tags.albumArtist } : {}),
    ...(tags.genre ? { genre: tags.genre } : {}),
    ...(tags.year ? { year: tags.year } : {}),
    ...(tags.track ? { track: tags.track } : {}),
    ...(tags.disc ? { disc: tags.disc } : {}),
    ...(tags.comment ? { comment: tags.comment } : {}),
    ...(tags.composer ? { composer: tags.composer } : {}),
    ...(tags.bpm ? { bpm: tags.bpm } : {}),
    ...(tags.isrc ? { isrc: tags.isrc } : {}),
    ...(tags.lyrics ? { lyrics: tags.lyrics } : {}),
    ...(tags.copyright ? { copyright: tags.copyright } : {}),
    ...(tags.publisher ? { publisher: tags.publisher } : {}),
    ...(tags.encodedBy ? { encodedBy: tags.encodedBy } : {}),
  };
}

/** atempo supports 0.5–100 in ffmpeg 9, but old builds stop at 2. Chain safely. */
export function atempoChain(ratio: number): string {
  const parts: string[] = [];
  let remaining = ratio;
  while (remaining > 2) {
    parts.push("atempo=2");
    remaining /= 2;
  }
  while (remaining < 0.5) {
    parts.push("atempo=0.5");
    remaining /= 0.5;
  }
  parts.push(`atempo=${Number(remaining.toFixed(6))}`);
  return parts.join(",");
}

export class AudioService {
  private readonly semaphore: Semaphore;
  private filters: Promise<Set<string>> | null = null;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly events: EventBus,
    private readonly uploads: UploadService
  ) {
    this.semaphore = new Semaphore(config.audio.maxConcurrent);
  }

  async availableFilters(): Promise<Set<string>> {
    this.filters ??= listFilters(this.config.audio.ffmpegPath).catch((error: unknown) => {
      this.logger.warn("ffmpeg filter discovery failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return new Set<string>();
    });
    return this.filters;
  }

  async probe(filePath: string): Promise<AudioInfo> {
    const resolved = this.uploads.resolvePath(filePath, "audio");
    const [probe, tagData] = await Promise.all([
      probeMedia(this.config.audio.ffprobePath, resolved.path),
      readTagsFromFile(resolved.path).catch(() => null),
    ]);
    return this.toInfo(probe, tagData?.tags ?? null, resolved.path);
  }

  async readTags(filePath: string, includeArtworkData = false): Promise<{
    path: string;
    tags: Id3Tags;
    artwork: { mimeType: string; bytes: number; description: string; data_base64?: string } | null;
    warnings: string[];
  }> {
    const resolved = this.uploads.resolvePath(filePath, "audio");
    const result = await readTagsFromFile(resolved.path);
    const artwork = result.tags.artwork;
    const { artwork: _artwork, ...tagFields } = result.tags;
    return {
      path: resolved.path,
      tags: tagFields,
      artwork: artwork
        ? {
            mimeType: artwork.mimeType,
            bytes: artwork.data.length,
            description: artwork.description,
            ...(includeArtworkData ? { data_base64: artwork.data.toString("base64") } : {}),
          }
        : null,
      warnings: result.tags.warnings,
    };
  }

  async updateTags(request: UpdateTagsRequest): Promise<{
    path: string;
    tags: Id3Tags;
    backup_path?: string;
    tag_bytes: number;
    audio_bytes: number;
    info: AudioInfo;
  }> {
    const resolved = this.uploads.resolvePath(request.filePath, "audio");
    const output = request.outputPath
      ? this.resolveOutputPath(resolved.path, request.outputPath, "tagged", ".mp3")
      : resolved.path;
    if (extname(output).toLowerCase() !== ".mp3") {
      throw new AppError("UNSUPPORTED_MEDIA", "ID3 tags can only be written to .mp3 files.", {
        status: 415,
      });
    }
    let artwork: ArtworkInput | null | undefined;
    if (request.artworkPath) {
      artwork = await this.loadArtwork(request.artworkPath);
    }
    const result = await writeId3Tags({
      path: resolved.path,
      edits: request.edits,
      ...(artwork !== undefined ? { artwork } : {}),
      removeArtwork: request.removeArtwork === true,
      ...(output !== resolved.path ? { outputPath: output } : {}),
      backup: request.backup !== false,
    });
    const info = await this.probe(result.path);
    return {
      path: result.path,
      tags: result.tags,
      ...(result.backupPath ? { backup_path: result.backupPath } : {}),
      tag_bytes: result.tagBytes,
      audio_bytes: result.audioBytes,
      info,
    };
  }

  async process(request: ProcessRequest): Promise<ProcessResult> {
    const started = Date.now();
    const input = await this.probe(request.filePath);
    const warnings: string[] = [];
    const filters = await this.availableFilters();
    const useRubberband =
      (request.algorithm ?? "auto") !== "atempo" && filters.has("rubberband");

    const format =
      request.format ??
      (() => {
        const inferred = extname(input.path).slice(1).toLowerCase();
        if (request.operation !== "convert" && ["mp3", "wav", "flac"].includes(inferred)) {
          return inferred as "mp3" | "wav" | "flac";
        }
        return "mp3";
      })();

    if (!["mp3", "wav", "flac"].includes(format)) {
      throw new AppError("BAD_REQUEST", `Unsupported output format ${format}.`, { status: 400 });
    }
    const extension = format === "mp3" ? ".mp3" : format === "wav" ? ".wav" : ".flac";
    const suffix = this.suffixFor(request);
    const outputPath = this.resolveOutputPath(input.path, request.outputPath, suffix, extension);
    if (!request.overwrite && (await this.exists(outputPath))) {
      throw new AppError("CONFLICT", `Output already exists: ${outputPath}. Pass overwrite=true.`, {
        status: 409,
      });
    }

    const filterChain = this.buildFilterChain(request, input, filters, useRubberband, warnings);
    const args = [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",
      "-progress",
      "pipe:1",
      "-nostats",
      request.overwrite ? "-y" : "-n",
      "-i",
      input.path,
      "-vn",
      "-map_metadata",
      "0",
    ];
    if (filterChain.length > 0) args.push("-filter:a", filterChain);
    args.push(...this.codecArgs(format, request.bitrateKbps, extension));
    args.push(outputPath);

    const jobId = randomUUID();
    let lastEmit = 0;
    const release = await this.semaphore.acquire();
    try {
      await runFfmpeg(this.config.audio.ffmpegPath, args, {
        durationSeconds: input.duration_seconds,
        ...(request.signal ? { signal: request.signal } : {}),
        onProgress: (seconds, percent) => {
          request.onProgress?.(seconds, percent);
          const now = Date.now();
          if (now - lastEmit < 500 && percent < 99) return;
          lastEmit = now;
          this.events.publish({
            type: "audio.progress",
            jobId,
            operation: request.operation,
            percent,
            elapsedSeconds: Math.round(seconds * 10) / 10,
          });
        },
      });
    } finally {
      release();
    }

    // Preserve metadata. ID3 is an MP3 structure; wav/flac rely on ffmpeg's
    // native metadata mapping and are not given an ID3 tag.
    if (extension === ".mp3" && request.keepTags !== false) {
      try {
        const original = await readTagsFromFile(input.path);
        const edits: Id3Edits = { ...tagsToEdits(original.tags), ...(request.tagEdits ?? {}) };
        let artwork: ArtworkInput | null | undefined;
        if (request.artworkPath) artwork = await this.loadArtwork(request.artworkPath);
        else if (request.removeArtwork) artwork = null;
        else if (original.tags.artwork) {
          artwork = {
            mimeType: original.tags.artwork.mimeType,
            data: original.tags.artwork.data,
            description: original.tags.artwork.description,
          };
        }
        await writeId3Tags({
          path: outputPath,
          edits,
          ...(artwork !== undefined ? { artwork } : {}),
          removeArtwork: request.removeArtwork === true,
          backup: false,
        });
      } catch (error) {
        warnings.push(`Metadata copy failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (extension !== ".mp3" && (request.tagEdits || request.artworkPath)) {
      warnings.push("ID3 tags can only be written to MP3 output; use MP3 or edit the source tags first.");
    }

    const output = await this.probe(outputPath);
    return {
      operation: request.operation,
      input,
      output,
      output_path: outputPath,
      elapsed_ms: Date.now() - started,
      warnings,
    };
  }

  private buildFilterChain(
    request: ProcessRequest,
    input: AudioInfo,
    filters: Set<string>,
    useRubberband: boolean,
    warnings: string[]
  ): string {
    switch (request.operation) {
      case "tempo": {
        const ratio = clampRatio(request.ratio);
        if (ratio === 1) return "";
        return useRubberband ? `rubberband=tempo=${ratio}` : atempoChain(ratio);
      }
      case "pitch": {
        const ratio = clampRatio(request.ratio);
        if (ratio === 1) return "";
        if (useRubberband) return `rubberband=pitch=${ratio}`;
        const sampleRate = input.sample_rate ?? 44_100;
        return `asetrate=${Math.round(sampleRate * ratio)},aresample=${sampleRate},${atempoChain(1 / ratio)}`;
      }
      case "speed": {
        const ratio = clampRatio(request.ratio);
        if (ratio === 1) return "";
        const sampleRate = input.sample_rate ?? 44_100;
        // Tape-style: pitch and duration both change.
        return `asetrate=${Math.round(sampleRate * ratio)},aresample=${sampleRate}`;
      }
      case "both": {
        const tempo = clampRatio(request.ratio);
        const pitch = clampRatio(request.pitch ?? request.ratio);
        if (useRubberband) return `rubberband=tempo=${tempo}:pitch=${pitch}`;
        warnings.push("rubberband is unavailable; using atempo (pitch is preserved) for both.");
        return atempoChain(tempo);
      }
      case "normalize": {
        if (!filters.has("loudnorm")) {
          throw new AppError("UNSUPPORTED_MEDIA", "ffmpeg loudnorm filter is unavailable.", { status: 501 });
        }
        const lufs = Math.min(-5, Math.max(-24, request.targetLufs ?? -14));
        const peak = Math.min(0, Math.max(-9, request.truePeak ?? -1));
        const lra = Math.min(50, Math.max(1, request.lra ?? 11));
        return `loudnorm=I=${lufs}:TP=${peak}:LRA=${lra}`;
      }
      case "trim": {
        const start = Math.max(0, request.startSeconds ?? 0);
        const end = request.endSeconds ?? input.duration_seconds;
        if (!Number.isFinite(end) || end <= start) {
          throw new AppError("BAD_REQUEST", "end_seconds must be greater than start_seconds.", {
            status: 400,
          });
        }
        return `atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS`;
      }
      case "convert":
        return "";
      default:
        throw new AppError("BAD_REQUEST", `Unknown operation ${request.operation as string}.`, {
          status: 400,
        });
    }
  }

  private codecArgs(format: string, bitrateKbps: number | undefined, extension: string): string[] {
    if (format === "mp3") {
      const bitrate = Math.min(320, Math.max(64, bitrateKbps ?? 320));
      return ["-c:a", "libmp3lame", "-b:a", `${bitrate}k`, "-id3v2_version", "4"];
    }
    if (format === "wav") return ["-c:a", "pcm_s16le"];
    if (format === "flac") return ["-c:a", "flac"];
    throw new AppError("BAD_REQUEST", `Unsupported extension ${extension}.`, { status: 400 });
  }

  private suffixFor(request: ProcessRequest): string {
    const ratio = request.ratio ? String(clampRatio(request.ratio)) : "";
    switch (request.operation) {
      case "tempo":
        return `tempo${ratio}`;
      case "pitch":
        return `pitch${ratio}`;
      case "speed":
        return `speed${ratio}`;
      case "both":
        return `tempo${ratio}pitch${request.pitch ?? request.ratio ?? 1}`;
      case "normalize":
        return "normalized";
      case "trim":
        return `trim${request.startSeconds ?? 0}-${request.endSeconds ?? "end"}`;
      case "convert":
        return "converted";
      default:
        return "edited";
    }
  }

  private resolveOutputPath(
    inputPath: string,
    requested: string | undefined,
    suffix: string,
    extension: string
  ): string {
    const allowedRoots = [...this.config.mediaRoots, this.config.audio.workDir];
    const verify = (candidate: string): string => {
      const absolute = resolvePath(candidate);
      if (!allowedRoots.some((root) => isWithin(resolvePath(root), absolute))) {
        throw new AppError("FORBIDDEN", `Output must stay inside SC_MEDIA_DIRS or the audio work dir.`, {
          status: 403,
        });
      }
      return absolute;
    };

    if (requested && requested.trim().length > 0) {
      const candidate = isAbsolute(requested)
        ? requested
        : join(dirname(inputPath), requested);
      return verify(candidate);
    }

    const base = basename(inputPath, extname(inputPath));
    const directory = dirname(inputPath);
    let candidate = join(directory, `${base}.${suffix}${extension}`);
    let counter = 2;
    while (this.existsSync(candidate) && counter < 100) {
      candidate = join(directory, `${base}.${suffix}-${counter}${extension}`);
      counter += 1;
    }
    return verify(candidate);
  }

  private existsSync(path: string): boolean {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  }

  private exists(path: string): Promise<boolean> {
    return stat(path)
      .then((info) => info.isFile())
      .catch(() => false);
  }

  private async loadArtwork(filePath: string): Promise<ArtworkInput> {
    const resolved = this.uploads.resolvePath(filePath, "image");
    const info = await stat(resolved.path);
    if (info.size > MAX_ARTWORK_BYTES) {
      throw new AppError("UPLOAD_TOO_LARGE", `Artwork exceeds ${MAX_ARTWORK_BYTES} bytes.`, {
        status: 413,
      });
    }
    const data = await readFile(resolved.path);
    return { mimeType: inferArtworkMime(resolved.path), data };
  }

  private toInfo(probe: ProbeResult, tags: Id3Tags | null, path: string): AudioInfo {
    return {
      path,
      size: probe.size,
      duration_seconds: Math.round(probe.durationSeconds * 1000) / 1000,
      bitrate: probe.bitrate,
      sample_rate: probe.sampleRate,
      channels: probe.channels,
      codec: probe.codec,
      container: probe.container,
      tags: tags ?? { warnings: [] },
    };
  }
}
