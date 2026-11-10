/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { execFileSync } from "node:child_process";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { jsonTool, stringOrStringArray } from "./helpers.js";
import { WebActionSession } from "../web/actions.js";
import { exportSoundCloudCookies, refreshSoundCloudCookies } from "../web/cookies.js";
import { webSessionStatus } from "../web/doctor.js";
import { runWebChain } from "../web/selftest.js";
import { WebUploader, type AlbumType } from "../web/upload.js";

function probeDuration(ctx: ToolContext, filePath: string): number | undefined {
  try {
    const output = execFileSync(
      ctx.config.audio.ffprobePath,
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath],
      { encoding: "utf8", timeout: 20_000 }
    ).trim();
    const value = Number(output);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

async function withWebSession<T>(ctx: ToolContext, run: (uploader: WebUploader, session: WebActionSession) => Promise<T>): Promise<T> {
  const session = new WebActionSession({
    logger: (level, message) => {
      if (level === "debug") ctx.logger.debug(message);
      else if (level === "warn") ctx.logger.warn(message);
      else ctx.logger.info(message);
    },
  });
  await session.start();
  try {
    return await run(new WebUploader(session), session);
  } finally {
    await session.close();
  }
}

export function registerWebTools(server: McpServer, ctx: ToolContext): void {
  jsonTool(
    server,
    "web_cookies_export",
    {
      title: "Export fresh SoundCloud cookies from the local browser",
      description:
        "Reads the local Chrome/Chromium cookie database (staging it through root on Android when needed), decrypts the SoundCloud cookies " +
        "(OSCrypt v10, AES-128-CBC) and writes the 0600 JSON that the web-session tools consume. Values are never returned; " +
        "the response reports the cookie names, token expiry and missing required cookies.",
      schema: {
        db_path: z.string().min(1).optional().describe("Explicit Chrome Cookies database path"),
        out_path: z.string().min(1).optional().describe("Destination JSON (default DATA_DIR/chrome-soundcloud-cookies.json)"),
      },
      annotations: { idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      exportSoundCloudCookies({
        ...(args.db_path ? { dbPath: args.db_path as string } : {}),
        ...(args.out_path ? { outPath: args.out_path as string } : {}),
      })
  );

  jsonTool(
    server,
    "web_cookies_refresh",
    {
      title: "Refresh the stored SoundCloud web session token",
      description:
        "Exchanges the oauth_refresh_token in the cookie file for a new oauth_token (public-client refresh, no client secret) and rewrites the file. " +
        "Useful when web_session_status reports an expiring token; no browser is needed.",
      schema: {},
      annotations: { idempotentHint: true, openWorldHint: true },
    },
    async () => refreshSoundCloudCookies()
  );

  jsonTool(
    server,
    "web_session_status",
    {
      title: "SoundCloud web-session status",
      description:
        "Reports cookie file freshness/permissions, oauth_token lifetime, Chromium availability and, with probe=true, opens the live upload page " +
        "to confirm the session and count the discovered server actions.",
      schema: {
        probe: z.boolean().default(false).describe("Open the live upload page and verify the account"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      webSessionStatus({
        probe: args.probe === true,
        logger: (level, message) => (level === "debug" ? ctx.logger.debug(message) : level === "warn" ? ctx.logger.warn(message) : ctx.logger.info(message)),
      })
  );

  jsonTool(
    server,
    "web_delete_track",
    {
      title: "Delete a track through the web session",
      description:
        "Deletes a track via api-v2 DELETE /tracks/{id} using the web session's OAuth cookie. Irreversible: the track disappears from the account " +
        "and any album it was in. Use web_chain_selftest for a safe end-to-end check that cleans up after itself.",
      schema: {
        track_urn: z.string().min(1).describe("Track URN or numeric id, e.g. soundcloud:tracks:123456789"),
      },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) => withWebSession(ctx, async (uploader) => {
      await uploader.deleteTrack(args.track_urn as string);
      return { deleted: true, track: args.track_urn };
    })
  );

  jsonTool(
    server,
    "web_chain_selftest",
    {
      title: "End-to-end SoundCloud web-session self-test",
      description:
        "Runs the complete runtime chain on the real account: cookie check -> live session -> empty album -> private upload through the presigned S3 policy " +
        "-> createTrack -> addToPlaylist -> read-back verification -> delete track and album. Leaves no residue unless keep=true.",
      schema: {
        file_path: z.string().min(1).optional().describe("Audio file to use; a 6-second tone is generated when omitted"),
        keep: z.boolean().default(false).describe("Keep the created track/album for inspection"),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async (args) =>
      runWebChain({
        ...(args.file_path ? { file: ctx.uploads.resolvePath(args.file_path as string, "audio").path } : {}),
        keep: args.keep === true,
        logger: (level, message) => (level === "debug" ? ctx.logger.debug(message) : level === "warn" ? ctx.logger.warn(message) : ctx.logger.info(message)),
      })
  );

  jsonTool(
    server,
    "web_actions",
    {
      title: "List live SoundCloud web server actions",
      description:
        "Diagnostic: launches the logged-in SoundCloud web app in headless Chromium, reads its live chunk graph, and lists the private server actions " +
        "available to the upload page. Action ids change with every SoundCloud deployment, so they are discovered at runtime instead of hard-coded.",
      schema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const session = new WebActionSession({ logger: (level, message) => ctx.logger.debug(`[web:${level}] ${message}`) });
      await session.start();
      try {
        const discovered = await session.discoverActions();
        return {
          chunks_scanned: discovered.chunkCount,
          actions: Object.fromEntries([...discovered.actions.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
        };
      } finally {
        await session.close();
      }
    }
  );

  jsonTool(
    server,
    "web_upload_track",
    {
      title: "Upload a track through the SoundCloud web session",
      description:
        "Uploads audio through SoundCloud's own web uploader (createUploadPolicyAction -> presigned S3 PUT -> createTrackAction), " +
        "which works for accounts that cannot register an API app. Optionally creates an album containing the new track. " +
        "Requires a logged-in web session: export browser cookies with scripts/stealth-import-cookies.py and point SC_WEB_COOKIE_FILE at the JSON.",
      schema: {
        file_path: z.string().min(1).describe("Audio path inside SC_MEDIA_DIRS"),
        title: z.string().min(1).max(300).optional().describe("Defaults to the file name without extension"),
        artist: z.string().max(200).optional(),
        genre: z.string().max(200).optional(),
        tags: stringOrStringArray("Tags as an array or comma-separated string").optional(),
        permalink: z.string().max(200).optional(),
        license: z.string().max(60).optional().describe("SoundCloud license id (default all-rights-reserved)"),
        sharing: z.enum(["public", "private"]).default("public"),
        album_title: z.string().min(1).max(300).optional().describe("Create an album with this title and add the track"),
        album_urn: z.string().min(1).optional().describe("Append the track to an existing album/playlist URN, e.g. soundcloud:playlists:123456789"),
        album_type: z.enum(["ALBUM", "EP"]).optional(),
        verify: z.boolean().default(true).describe("Read the created track back through the web session"),
      },
      annotations: { idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const resolved = ctx.uploads.resolvePath(args.file_path as string, "audio");
      const durationSeconds = probeDuration(ctx, resolved.path);
      const tags = Array.isArray(args.tags) ? (args.tags as string[]) : typeof args.tags === "string" ? (args.tags as string).split(",").map((tag) => tag.trim()).filter(Boolean) : undefined;
      return withWebSession(ctx, async (uploader, session) => {
        const result = await uploader.upload({
          filePath: resolved.path,
          title: (args.title as string | undefined) ?? resolved.path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "Untitled",
          ...(args.artist ? { artist: args.artist as string } : {}),
          ...(args.genre ? { genre: args.genre as string } : {}),
          ...(tags && tags.length > 0 ? { tags } : {}),
          ...(args.permalink ? { permalink: args.permalink as string } : {}),
          ...(args.license ? { license: args.license as string } : {}),
          ...(args.sharing === "private" ? { shareAccess: "PRIVATE" as const } : {}),
          ...(durationSeconds ? { durationSeconds } : {}),
          ...(args.album_title ? { albumTitle: args.album_title as string } : {}),
          ...(args.album_urn ? { albumUrn: args.album_urn as string } : {}),
          ...(args.album_type ? { albumType: args.album_type as AlbumType } : {}),
        });
        let verified: unknown;
        if ((args.verify as boolean | undefined) ?? true) {
          const urn = (result.track as { urn?: string } | null)?.urn;
          if (urn) {
            try {
              verified = await session.call("getTrackInfoAction", urn);
            } catch (error) {
              verified = { error: error instanceof Error ? error.message : String(error) };
            }
          }
        }
        return {
          uid: result.uid,
          upload: result.upload,
          track: result.track,
          ...(result.album !== undefined ? { album: result.album } : {}),
          ...(verified !== undefined ? { verified } : {}),
        };
      });
    }
  );

  jsonTool(
    server,
    "web_create_album",
    {
      title: "Create an album from existing tracks (web session)",
      description: "Creates an album or EP through SoundCloud's private createAlbumAction, referencing existing track URNs.",
      schema: {
        title: z.string().min(1).max(300),
        track_urns: z.array(z.string().min(1)).min(1).describe("Track URNs, e.g. soundcloud:tracks:123456789"),
        genre: z.string().max(200).optional(),
        type: z.enum(["ALBUM", "EP"]).default("ALBUM"),
        public: z.boolean().default(true),
      },
      annotations: { idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      withWebSession(ctx, async (uploader) =>
        uploader.createAlbum({
          title: args.title as string,
          trackUrns: args.track_urns as string[],
          ...(args.genre ? { genre: args.genre as string } : {}),
          type: (args.type as AlbumType | undefined) ?? "ALBUM",
          public: (args.public as boolean | undefined) ?? true,
        })
      )
  );
}
