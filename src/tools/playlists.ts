/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toUrn } from "../util/ids.js";
import type { ToolContext } from "./context.js";
import { idSchema, jsonTool, stringOrStringArray } from "./helpers.js";

function playlistUrn(value: unknown): string {
  return toUrn("playlists", value as string | number);
}

function trackUrn(value: string | number): string {
  return toUrn("tracks", value);
}

const trackIdList = z.array(z.union([z.string(), z.number().int().nonnegative()])).max(500);

export function registerPlaylistTools(server: McpServer, ctx: ToolContext): void {
  jsonTool(
    server,
    "list_my_playlists",
    {
      title: "List my playlists",
      description: "Lists the authenticated user's playlists with pagination.",
      schema: {
        limit: z.number().int().min(1).max(200).optional(),
        max_items: z.number().int().min(1).max(2000).optional(),
        cursor: z.string().url().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      ctx.api.myPlaylists({
        limit: args.limit as number | undefined,
        maxItems: args.max_items as number | undefined,
        cursor: args.cursor as string | undefined,
      })
  );

  jsonTool(
    server,
    "get_playlist",
    {
      title: "Get playlist",
      description: "Returns a playlist with its tracks.",
      schema: { playlist_id: idSchema("Playlist id or URN") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => ctx.api.playlist(playlistUrn(args.playlist_id))
  );

  jsonTool(
    server,
    "create_playlist",
    {
      title: "Create playlist",
      description: "Creates a playlist (private by default) and optionally seeds it with track ids/URNs.",
      schema: {
        title: z.string().min(1).max(300),
        description: z.string().max(4000).optional(),
        sharing: z.enum(["public", "private"]).default("private"),
        genre: z.string().max(200).optional(),
        tags: stringOrStringArray("Tags as an array or space-separated string").optional(),
        label_name: z.string().max(200).optional(),
        release_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        permalink: z.string().max(200).optional(),
        purchase_url: z.string().url().max(500).optional(),
        purchase_title: z.string().max(200).optional(),
        set_type: z.enum(["album", "playlist"]).optional(),
        ean: z.string().max(30).optional(),
        license: z.string().max(60).optional(),
        track_ids: trackIdList.optional(),
      },
      annotations: { idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      ctx.api.createPlaylist({
        title: args.title as string,
        description: args.description as string | undefined,
        sharing: (args.sharing as "public" | "private" | undefined) ?? "private",
        genre: args.genre as string | undefined,
        tags: args.tags as string | string[] | undefined,
        labelName: args.label_name as string | undefined,
        releaseDate: args.release_date as string | undefined,
        permalink: args.permalink as string | undefined,
        purchaseUrl: args.purchase_url as string | undefined,
        purchaseTitle: args.purchase_title as string | undefined,
        setType: args.set_type as "album" | "playlist" | undefined,
        ean: args.ean as string | undefined,
        license: args.license as string | undefined,
        ...(args.track_ids
          ? { trackUrns: (args.track_ids as Array<string | number>).map((id) => trackUrn(id)) }
          : {}),
      })
  );

  jsonTool(
    server,
    "update_playlist",
    {
      title: "Update playlist",
      description: "Updates playlist metadata and/or replaces the track list. Omitted fields are unchanged.",
      schema: {
        playlist_id: idSchema("Playlist id or URN"),
        title: z.string().min(1).max(300).optional(),
        description: z.string().max(4000).optional(),
        sharing: z.enum(["public", "private"]).optional(),
        genre: z.string().max(200).optional(),
        tags: stringOrStringArray("Tags as an array or space-separated string").optional(),
        label_name: z.string().max(200).optional(),
        release_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        permalink: z.string().max(200).optional(),
        purchase_url: z.string().url().max(500).optional(),
        purchase_title: z.string().max(200).optional(),
        set_type: z.enum(["album", "playlist"]).optional(),
        ean: z.string().max(30).optional(),
        license: z.string().max(60).optional(),
        track_ids: trackIdList.optional().describe("Replaces the entire track list"),
        clear_tracks: z.boolean().optional(),
      },
      annotations: { idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      ctx.api.updatePlaylist(playlistUrn(args.playlist_id), {
        title: args.title as string | undefined,
        description: args.description as string | undefined,
        sharing: args.sharing as "public" | "private" | undefined,
        genre: args.genre as string | undefined,
        tags: args.tags as string | string[] | undefined,
        labelName: args.label_name as string | undefined,
        releaseDate: args.release_date as string | undefined,
        permalink: args.permalink as string | undefined,
        purchaseUrl: args.purchase_url as string | undefined,
        purchaseTitle: args.purchase_title as string | undefined,
        setType: args.set_type as "album" | "playlist" | undefined,
        ean: args.ean as string | undefined,
        license: args.license as string | undefined,
        ...(args.track_ids
          ? { trackUrns: (args.track_ids as Array<string | number>).map((id) => trackUrn(id)) }
          : {}),
        ...(args.clear_tracks ? { clearTracks: true } : {}),
      })
  );

  jsonTool(
    server,
    "add_tracks_to_playlist",
    {
      title: "Add tracks to playlist",
      description: "Appends tracks without replacing existing ones (deduplicated).",
      schema: {
        playlist_id: idSchema("Playlist id or URN"),
        track_ids: trackIdList.min(1).describe("Tracks to append"),
      },
      annotations: { idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      ctx.api.addTracks(
        playlistUrn(args.playlist_id),
        (args.track_ids as Array<string | number>).map((id) => trackUrn(id))
      )
  );

  jsonTool(
    server,
    "remove_track_from_playlist",
    {
      title: "Remove track from playlist",
      description: "Removes one track from a playlist, preserving the order of the rest.",
      schema: {
        playlist_id: idSchema("Playlist id or URN"),
        track_id: idSchema("Track id or URN"),
      },
      annotations: { idempotentHint: true, openWorldHint: true },
    },
    async (args) => ctx.api.removeTrack(playlistUrn(args.playlist_id), trackUrn(args.track_id as string | number))
  );

  jsonTool(
    server,
    "reorder_playlist",
    {
      title: "Reorder playlist",
      description:
        "Replaces the track order. `track_ids` must list every current track exactly once (no partial reorders).",
      schema: {
        playlist_id: idSchema("Playlist id or URN"),
        track_ids: trackIdList.min(1).describe("Full track list in the desired order"),
      },
      annotations: { idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      ctx.api.reorderPlaylist(
        playlistUrn(args.playlist_id),
        (args.track_ids as Array<string | number>).map((id) => trackUrn(id))
      )
  );

  jsonTool(
    server,
    "delete_playlist",
    {
      title: "Delete playlist",
      description: "Permanently deletes a playlist. Tracks themselves are not deleted.",
      schema: { playlist_id: idSchema("Playlist id or URN") },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const urn = playlistUrn(args.playlist_id);
      await ctx.api.deletePlaylist(urn);
      return { success: true, playlist_urn: urn, message: "Playlist deleted." };
    }
  );
}
