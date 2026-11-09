/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SoundCloudApi } from "../soundcloud/api.js";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { UploadService } from "../uploads/service.js";
import { openInBrowser } from "../util/browser.js";
import { jsonTool } from "./helpers.js";

export interface ProfileToolContext {
  api: SoundCloudApi;
  uploads: UploadService;
  config: Config;
  logger: Logger;
  connectionId: string;
  isLoopback: boolean;
}

export function registerProfileTools(server: McpServer, ctx: ProfileToolContext): void {
  jsonTool(
    server,
    "get_me",
    {
      title: "Get my SoundCloud profile",
      description:
        "Returns the authenticated SoundCloud profile: identity, counts, plan, and upload quota (upload_seconds_left).",
      schema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => ctx.api.me()
  );

  jsonTool(
    server,
    "get_upload_quota",
    {
      title: "Get upload quota",
      description: "Returns remaining upload time and whether the account has an unlimited upload quota.",
      schema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => ctx.api.quota()
  );

  jsonTool(
    server,
    "update_profile",
    {
      title: "Update my profile",
      description:
        "Updates artist profile fields via PUT /me (display name, name parts, bio, city, country, website). " +
        "Only provided fields change.",
      schema: {
        username: z.string().min(1).max(200).optional(),
        first_name: z.string().max(200).optional(),
        last_name: z.string().max(200).optional(),
        full_name: z.string().max(200).optional(),
        description: z.string().max(4000).optional(),
        city: z.string().max(120).optional(),
        country: z.string().max(120).optional(),
        website: z.string().url().max(500).optional(),
        website_title: z.string().max(200).optional(),
        discogs_name: z.string().max(200).optional(),
      },
      annotations: { idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      ctx.api.updateProfile({
        username: args.username as string | undefined,
        first_name: args.first_name as string | undefined,
        last_name: args.last_name as string | undefined,
        full_name: args.full_name as string | undefined,
        description: args.description as string | undefined,
        city: args.city as string | undefined,
        country: args.country as string | undefined,
        website: args.website as string | undefined,
        website_title: args.website_title as string | undefined,
        discogs_name: args.discogs_name as string | undefined,
      })
  );

  jsonTool(
    server,
    "upload_avatar",
    {
      title: "Upload profile avatar",
      description:
        "Uploads a new profile avatar (JPEG/PNG/GIF/WebP) with PUT /me. The path must be inside SC_MEDIA_DIRS.",
      schema: {
        file_path: z.string().min(1).describe("Absolute path or path relative to an allowed media root"),
      },
      annotations: { idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const resolved = ctx.uploads.resolvePath(args.file_path as string, "image");
      const user = await ctx.api.uploadAvatar(resolved.path);
      return { user, note: "Avatar updated." };
    }
  );

  jsonTool(
    server,
    "open_auth_window",
    {
      title: "Open SoundCloud authorization in the default browser",
      description:
        "Opens the panel or the SoundCloud authorization flow in the user's normal browser/webview " +
        "(Android termux-open-url, Windows start, macOS open, Linux xdg-open/gio, WSL cmd.exe). " +
        "Returns the URL even when the opener is unavailable. Disable with MCP_OPEN_BROWSER=false.",
      schema: {
        target: z.enum(["auth", "panel"]).default("auth").describe("auth = /panel/auth/start, panel = /panel"),
      },
      annotations: { openWorldHint: false },
    },
    async (args) => {
      const target = (args.target as "auth" | "panel" | undefined) ?? "auth";
      const url = `${ctx.config.publicUrl}${target === "panel" ? "/panel" : "/panel/auth/start"}`;
      if (!ctx.config.autoOpenBrowser) {
        return { url, opened: false, reason: "MCP_OPEN_BROWSER=false" };
      }
      const result = await openInBrowser(url);
      return { url, ...result };
    }
  );

  jsonTool(
    server,
    "get_panel_url",
    {
      title: "Get control panel URL",
      description:
        "Returns the browser control-panel URL. In local mode on a loopback request the panel auto-logs-in; " +
        "otherwise open the URL and paste your MCP access token.",
      schema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ({
      url: `${ctx.config.publicUrl}/panel`,
      auto_login: ctx.config.security.panelAutoLogin && ctx.isLoopback,
      mode: ctx.config.mode,
      endpoints: {
        state: `${ctx.config.publicUrl}/api/state`,
        upload: `${ctx.config.publicUrl}/api/upload`,
        events: `${ctx.config.publicUrl}/api/events`,
      },
    })
  );
}
