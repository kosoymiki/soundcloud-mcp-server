/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { closeSync, openSync, readSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { EventBus } from "../events.js";
import type { SoundCloudApi, UploadMetadata } from "../soundcloud/api.js";
import { makeFilePart, type FilePart } from "../soundcloud/multipart.js";
import { parseId3, type Id3Tags } from "../soundcloud/id3.js";
import { AppError } from "../errors.js";

const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".flac", ".aiff", ".aif", ".ogg", ".oga", ".m4a", ".aac", ".wma", ".amr"]);
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const ID3_READ_LIMIT = 16 * 1024 * 1024;

export interface UploadRequest {
  filePath: string;
  fileName?: string;
  metadata: Omit<UploadMetadata, "title"> & { title?: string };
  autoTag?: boolean;
  artworkPath?: string;
  attachArtwork?: boolean;
  signal?: AbortSignal;
  onProgress?: (sent: number, total: number) => void;
  uploadId?: string;
}

export interface UploadResult {
  track: Record<string, unknown>;
  warnings: string[];
  metadata: UploadMetadata;
  file: { path: string; name: string; size: number };
}

function isWithin(root: string, candidate: string): boolean {
  const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate === root || candidate.startsWith(normalizedRoot);
}

export class UploadService {
  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly events: EventBus,
    private readonly api: SoundCloudApi
  ) {}

  /** Returns a service bound to another connection's API instance. */
  withApi(api: SoundCloudApi): UploadService {
    return new UploadService(this.config, this.logger, this.events, api);
  }

  /** Resolve a user-supplied path inside one of the configured media roots. */
  resolvePath(input: string, kind: "audio" | "image"): { path: string; size: number } {
    if (!input || input.trim().length === 0) {
      throw new AppError("BAD_REQUEST", "A file path is required.", { status: 400 });
    }
    const candidates: string[] = [];
    if (input.startsWith("~/")) candidates.push(join(process.env.HOME ?? "", input.slice(2)));
    else if (input.startsWith("/")) candidates.push(input);
    else {
      for (const root of this.config.mediaRoots) candidates.push(resolve(root, input));
    }

    let real: string | null = null;
    for (const candidate of candidates) {
      try {
        real = realpathSync(candidate);
        break;
      } catch {
        // Try the next root.
      }
    }
    if (!real) {
      throw new AppError("NOT_FOUND", `File not found: ${input}`, { status: 404 });
    }

    const allowedRoots = [...this.config.mediaRoots, join(this.config.dataDir, "uploads")];
    const allowed = allowedRoots.some((root) => {
      try {
        return isWithin(realpathSync(root), real as string);
      } catch {
        return false;
      }
    });
    if (!allowed) {
      throw new AppError(
        "FORBIDDEN",
        `Refusing to read outside SC_MEDIA_DIRS (${this.config.mediaRoots.join(", ")}).`,
        { status: 403 }
      );
    }

    const stats = statSync(real);
    if (!stats.isFile()) throw new AppError("BAD_REQUEST", `${input} is not a regular file.`, { status: 400 });

    const ext = extname(real).toLowerCase();
    if (kind === "audio" && !AUDIO_EXTENSIONS.has(ext)) {
      throw new AppError("UNSUPPORTED_MEDIA", `Unsupported audio extension ${ext}.`, {
        status: 415,
        details: { supported: [...AUDIO_EXTENSIONS] },
      });
    }
    if (kind === "image" && !IMAGE_EXTENSIONS.has(ext)) {
      throw new AppError("UNSUPPORTED_MEDIA", `Unsupported image extension ${ext}.`, {
        status: 415,
        details: { supported: [...IMAGE_EXTENSIONS] },
      });
    }
    if (stats.size > this.config.sc.maxUploadBytes) {
      throw new AppError(
        "UPLOAD_TOO_LARGE",
        `File is ${stats.size} bytes; the configured limit is ${this.config.sc.maxUploadBytes}.`,
        { status: 413 }
      );
    }
    return { path: real, size: stats.size };
  }

  readTags(filePath: string): Id3Tags | null {
    const ext = extname(filePath).toLowerCase();
    if (ext !== ".mp3") return null;
    let fd: number | null = null;
    try {
      fd = openSync(filePath, "r");
      const size = Math.min(statSync(filePath).size, ID3_READ_LIMIT);
      const buffer = Buffer.alloc(size);
      readSync(fd, buffer, 0, size, 0);
      return parseId3(buffer);
    } catch (error) {
      this.logger.warn("ID3 parse failed", {
        file: basename(filePath),
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }

  async upload(request: UploadRequest): Promise<UploadResult> {
    const warnings: string[] = [];
    const resolved = this.resolvePath(request.filePath, "audio");
    const file: FilePart = makeFilePart(resolved.path, request.fileName);

    let tags: Id3Tags | null = null;
    if (request.autoTag !== false) {
      tags = this.readTags(resolved.path);
      if (tags) {
        warnings.push(...tags.warnings);
      }
    }

    const title =
      request.metadata.title?.trim() ||
      tags?.title?.trim() ||
      basename(resolved.path, extname(resolved.path)).replace(/[_-]+/g, " ").trim();

    if (!title) {
      throw new AppError("BAD_REQUEST", "Track title is required (could not read one from ID3).", {
        status: 400,
      });
    }

    const metadata: UploadMetadata = {
      ...request.metadata,
      title,
      ...(request.metadata.artist ? {} : tags?.artist ? { artist: tags.artist } : {}),
      ...(request.metadata.genre ? {} : tags?.genre ? { genre: tags.genre } : {}),
      ...(request.metadata.description ? {} : tags?.comment ? { description: tags.comment } : {}),
      ...(request.metadata.releaseDate ? {} : tags?.year ? { releaseDate: tags.year } : {}),
    };

    const uploadId = request.uploadId ?? randomUUID();
    let lastEmit = 0;
    const onProgress = (sent: number, total: number): void => {
      request.onProgress?.(sent, total);
      const now = Date.now();
      if (now - lastEmit < 500 && sent < total) return;
      lastEmit = now;
      this.events.publish({
        type: "upload.progress",
        uploadId,
        sent,
        total,
        percent: total > 0 ? Math.min(100, Math.round((sent / total) * 100)) : 0,
      });
    };

    this.events.publish({ type: "log", level: "info", message: `Uploading ${file.filename} (${file.size} bytes)` });
    let track: Record<string, unknown>;
    try {
      track = (await this.api.uploadTrack(metadata, file, {
        ...(request.signal ? { signal: request.signal } : {}),
        onProgress,
      })) as unknown as Record<string, unknown>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.events.publish({ type: "upload.error", uploadId, message });
      throw error;
    }

    const trackUrn =
      typeof track.urn === "string"
        ? track.urn
        : typeof track.id === "number"
          ? `soundcloud:tracks:${track.id}`
          : null;
    this.events.publish({
      type: "upload.done",
      uploadId,
      trackUrn: trackUrn ?? "",
      title: typeof track.title === "string" ? track.title : title,
    });

    // Artwork: explicit path wins; otherwise reuse embedded APIC when present.
    const artwork = request.artworkPath
      ? this.resolvePath(request.artworkPath, "image")
      : request.attachArtwork !== false && tags?.artwork
        ? this.writeTempArtwork(tags.artwork.data, tags.artwork.mimeType)
        : null;

    if (artwork && trackUrn) {
      try {
        const artworkFile = makeFilePart(artwork.path);
        const updated = await this.api.uploadArtwork(trackUrn, artworkFile, request.signal);
        track = updated as unknown as Record<string, unknown>;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`Track uploaded, but artwork failed: ${message}`);
        this.logger.warn("Artwork upload failed", { track: trackUrn, error: message });
      } finally {
        if (!request.artworkPath) {
          try {
            unlinkSync(artwork.path);
          } catch {
            // Temp file cleanup is best effort.
          }
        }
      }
    }

    return {
      track,
      warnings,
      metadata,
      file: { path: resolved.path, name: file.filename, size: file.size },
    };
  }

  private writeTempArtwork(data: Buffer, mimeType: string): { path: string } {
    const extension = mimeType.includes("png") ? ".png" : mimeType.includes("gif") ? ".gif" : ".jpg";
    const path = join(this.config.dataDir, `artwork-${randomUUID()}${extension}`);
    writeFileSync(path, data, { mode: 0o600 });
    return { path };
  }
}
