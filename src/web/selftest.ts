/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * One-command proof that the whole SoundCloud web-session runtime works:
 * cookies -> live session -> album -> presigned S3 upload -> createTrack ->
 * addToPlaylist -> read-back verification -> cleanup (track + album).
 *
 * Everything it creates is private and deleted again unless `keep` is set, so
 * it can be run on a real account without leaving residue.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "../errors.js";
import { WebActionSession } from "./actions.js";
import { inspectCookieFile } from "./cookies.js";
import { extractPlaylistUrn, extractTrackUrn, numericId, WebUploader } from "./upload.js";

export interface ChainStep {
  step: string;
  ok: boolean;
  ms: number;
  detail?: unknown;
  error?: string;
}

export interface ChainOptions {
  /** Audio file to upload; a 6-second tone is generated when omitted. */
  file?: string;
  /** Keep the created track/album instead of deleting them. */
  keep?: boolean;
  albumTitle?: string;
  cookieFile?: string;
  logger?: (level: "debug" | "info" | "warn", message: string) => void;
}

export interface ChainResult {
  ok: boolean;
  cleaned: boolean;
  album_urn: string | null;
  track_urn: string | null;
  file: string;
  steps: ChainStep[];
}

class StepFailure extends Error {}

async function record<T>(steps: ChainStep[], name: string, run: () => Promise<T> | T): Promise<T> {
  const started = Date.now();
  try {
    const value = await run();
    steps.push({ step: name, ok: true, ms: Date.now() - started, ...(value !== undefined ? { detail: value } : {}) });
    return value;
  } catch (error) {
    steps.push({
      step: name,
      ok: false,
      ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new StepFailure(error instanceof Error ? error.message : String(error));
  }
}

function generateTone(): { file: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "sc-chain-"));
  const file = join(dir, "selftest.mp3");
  const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
  execFileSync(
    ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-af", "volume=0.04", "-c:a", "libmp3lame", "-b:a", "128k", file, "-y"],
    { timeout: 60_000, stdio: "ignore" }
  );
  if (!existsSync(file)) throw new AppError("INTERNAL", "ffmpeg did not produce the self-test tone.", { status: 500 });
  return { file, dir };
}

async function waitFor(probe: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

export async function runWebChain(options: ChainOptions = {}): Promise<ChainResult> {
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const albumTitle = options.albumTitle ?? `chain-selftest-${stamp}`;
  const title = `chain-selftest-${stamp}`;
  const cookieFile = options.cookieFile ?? process.env.SC_WEB_COOKIE_FILE;
  const steps: ChainStep[] = [];
  const generated = options.file ? null : generateTone();
  const file = options.file ?? generated?.file ?? "";
  const result: ChainResult = { ok: false, cleaned: false, album_urn: null, track_urn: null, file, steps };

  const session = new WebActionSession({
    ...(cookieFile ? { cookieFile } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
  let uploader: WebUploader | null = null;
  let cleanupDone = false;

  const cleanup = async (): Promise<void> => {
    if (options.keep || cleanupDone) return;
    cleanupDone = true;
    if (result.track_urn) {
      await record(steps, "cleanup.track", async () => {
        await uploader?.deleteTrack(result.track_urn ?? "");
        const gone = await waitFor(async () => (await uploader?.getTrack(result.track_urn ?? "")) === null, 15_000);
        if (!gone) throw new Error("track is still listed after DELETE");
        return { deleted: true, id: numericId(result.track_urn ?? "") };
      }).catch(() => undefined);
    }
    if (result.album_urn) {
      await record(steps, "cleanup.album", async () => {
        await uploader?.deleteAlbum(result.album_urn ?? "");
        const gone = await waitFor(async () => (await uploader?.getAlbum(result.album_urn ?? "")) === null, 15_000);
        if (!gone) throw new Error("album is still listed after DELETE");
        return { deleted: true, id: numericId(result.album_urn ?? "") };
      }).catch(() => undefined);
    }
  };

  try {
    await record(steps, "cookies", () => {
      const file = inspectCookieFile(
        cookieFile ?? join(process.env.HOME ?? "", ".local", "share", "soundcloud-mcp", "chrome-soundcloud-cookies.json")
      );
      if (!file.exists) throw new Error(`no cookie file at ${cookieFile ?? "the default path"}`);
      if (file.expiresInSeconds !== null && file.expiresInSeconds <= 0) throw new Error("oauth_token is expired; re-export cookies");
      return { cookies: file.cookies, expires_in_seconds: file.expiresInSeconds, exported_at: file.exportedAt };
    });

    await record(steps, "session", async () => {
      await session.start();
      const me = await session.apiGet<{ id?: number; username?: string }>("/me");
      if (!me?.id) throw new Error("session is not authenticated");
      return { username: me.username, user_id: me.id };
    });
    uploader = new WebUploader(session);

    await record(steps, "album.create", async () => {
      const album = await uploader?.createAlbum({ title: albumTitle, trackUrns: [] });
      const urn = extractPlaylistUrn(album);
      if (!urn) throw new Error("createAlbumAction returned no playlist urn");
      result.album_urn = urn;
      return { album_urn: urn, title: albumTitle };
    });

    await record(steps, "upload", async () => {
      if (!result.album_urn) throw new Error("album was not created");
      const uploaded = await uploader?.upload({
        filePath: file,
        title,
        genre: "Test",
        shareAccess: "PRIVATE",
        albumUrn: result.album_urn,
      });
      const urn = extractTrackUrn(uploaded?.track);
      if (!urn) throw new Error("createTrackAction returned no track urn");
      result.track_urn = urn;
      return {
        track_urn: urn,
        uid: uploaded?.uid,
        bytes: uploaded?.upload.bytes,
        s3_status: uploaded?.upload.status,
        md5_matches: uploaded?.upload.etag?.replace(/"/g, "") === uploaded?.upload.md5,
        added_to_album: Boolean(uploaded?.album),
      };
    });

    await record(steps, "verify", async () => {
      if (!result.track_urn || !result.album_urn) throw new Error("nothing to verify");
      const info = await session.call<Record<string, unknown>>("getTrackInfoAction", result.track_urn);
      const track = await uploader?.getTrack(result.track_urn);
      if (!track) throw new Error("api-v2 does not list the created track");
      const album = await uploader?.getAlbum(result.album_urn);
      if (!album) throw new Error("api-v2 does not list the created album");
      const albumTracks = Array.isArray(album.tracks) ? (album.tracks as { urn?: string }[]) : [];
      const inAlbum = albumTracks.some((entry) => entry?.urn === result.track_urn);
      if (!inAlbum) throw new Error("the track is not present in the album");
      return {
        state: track.state,
        sharing: track.sharing,
        duration_ms: track.duration,
        action_state: (info as { state?: unknown } | null)?.state ?? null,
        album_track_count: albumTracks.length,
        permalink_url: track.permalink_url,
      };
    });

    await cleanup();
    result.cleaned = !options.keep && steps.filter((step) => step.step.startsWith("cleanup.")).every((step) => step.ok);
    result.ok = steps.every((step) => step.ok);
    return result;
  } catch (error) {
    // Remove anything already created, then report the failure as data.
    await cleanup();
    result.cleaned = !options.keep && steps.filter((step) => step.step.startsWith("cleanup.")).every((step) => step.ok);
    result.ok = false;
    if (!(error instanceof StepFailure)) {
      steps.push({ step: "chain", ok: false, ms: 0, error: error instanceof Error ? error.message : String(error) });
    }
    return result;
  } finally {
    await session.close().catch(() => undefined);
    if (generated) {
      try {
        rmSync(generated.dir, { recursive: true, force: true });
      } catch {
        // Temp cleanup is best effort.
      }
    }
  }
}
