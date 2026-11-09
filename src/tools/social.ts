/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toUrn } from "../util/ids.js";
import type { ToolContext } from "./context.js";
import { idSchema, jsonTool } from "./helpers.js";

const paging = {
  limit: z.number().int().min(1).max(200).optional(),
  max_items: z.number().int().min(1).max(2000).optional(),
  cursor: z.string().url().optional(),
};

function trackUrn(value: unknown): string {
  return toUrn("tracks", value as string | number);
}

function playlistUrn(value: unknown): string {
  return toUrn("playlists", value as string | number);
}

function userUrn(value: unknown): string {
  return toUrn("users", value as string | number);
}

export function registerSocialTools(server: McpServer, ctx: ToolContext): void {
  jsonTool(
    server,
    "like_track",
    {
      title: "Like track",
      description: "Likes a track as the authenticated user.",
      schema: { track_id: idSchema("Track id or URN") },
      annotations: { idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      await ctx.api.likeTrack(trackUrn(args.track_id));
      return { success: true, action: "liked", track_urn: trackUrn(args.track_id) };
    }
  );

  jsonTool(
    server,
    "unlike_track",
    {
      title: "Unlike track",
      description: "Removes a like from a track.",
      schema: { track_id: idSchema("Track id or URN") },
      annotations: { idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      await ctx.api.unlikeTrack(trackUrn(args.track_id));
      return { success: true, action: "unliked", track_urn: trackUrn(args.track_id) };
    }
  );

  jsonTool(
    server,
    "like_playlist",
    {
      title: "Like playlist",
      description: "Likes a playlist or system playlist (station).",
      schema: { playlist_id: idSchema("Playlist id or URN") },
      annotations: { idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      await ctx.api.likePlaylist(playlistUrn(args.playlist_id));
      return { success: true, action: "liked", playlist_urn: playlistUrn(args.playlist_id) };
    }
  );

  jsonTool(
    server,
    "unlike_playlist",
    {
      title: "Unlike playlist",
      description: "Removes a like from a playlist.",
      schema: { playlist_id: idSchema("Playlist id or URN") },
      annotations: { idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      await ctx.api.unlikePlaylist(playlistUrn(args.playlist_id));
      return { success: true, action: "unliked", playlist_urn: playlistUrn(args.playlist_id) };
    }
  );

  jsonTool(
    server,
    "repost_track",
    {
      title: "Repost track",
      description: "Reposts a track as the authenticated user.",
      schema: { track_id: idSchema("Track id or URN") },
      annotations: { idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      await ctx.api.repostTrack(trackUrn(args.track_id));
      return { success: true, action: "reposted", track_urn: trackUrn(args.track_id) };
    }
  );

  jsonTool(
    server,
    "unrepost_track",
    {
      title: "Remove repost",
      description: "Removes a repost from a track.",
      schema: { track_id: idSchema("Track id or URN") },
      annotations: { idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      await ctx.api.unrepostTrack(trackUrn(args.track_id));
      return { success: true, action: "unreposted", track_urn: trackUrn(args.track_id) };
    }
  );

  jsonTool(
    server,
    "follow_user",
    {
      title: "Follow user",
      description: "Follows a SoundCloud user (PUT /me/followings/{urn}).",
      schema: { user_id: idSchema("User id or URN") },
      annotations: { idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      await ctx.api.follow(userUrn(args.user_id));
      return { success: true, action: "followed", user_urn: userUrn(args.user_id) };
    }
  );

  jsonTool(
    server,
    "unfollow_user",
    {
      title: "Unfollow user",
      description: "Unfollows a SoundCloud user.",
      schema: { user_id: idSchema("User id or URN") },
      annotations: { idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      await ctx.api.unfollow(userUrn(args.user_id));
      return { success: true, action: "unfollowed", user_urn: userUrn(args.user_id) };
    }
  );

  jsonTool(
    server,
    "list_followers",
    {
      title: "List my followers",
      description: "Lists users who follow the authenticated account.",
      schema: paging,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      ctx.api.myFollowers({
        limit: args.limit as number | undefined,
        maxItems: args.max_items as number | undefined,
        cursor: args.cursor as string | undefined,
      })
  );

  jsonTool(
    server,
    "list_followings",
    {
      title: "List my followings",
      description: "Lists users followed by the authenticated account.",
      schema: paging,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      ctx.api.myFollowings({
        limit: args.limit as number | undefined,
        maxItems: args.max_items as number | undefined,
        cursor: args.cursor as string | undefined,
      })
  );

  jsonTool(
    server,
    "list_likes",
    {
      title: "List my likes",
      description: "Lists tracks liked by the authenticated account.",
      schema: paging,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      ctx.api.myLikes({
        limit: args.limit as number | undefined,
        maxItems: args.max_items as number | undefined,
        cursor: args.cursor as string | undefined,
      })
  );

  jsonTool(
    server,
    "list_reposts",
    {
      title: "List my reposts",
      description: "Lists tracks reposted by the authenticated account.",
      schema: paging,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      ctx.api.myReposts({
        limit: args.limit as number | undefined,
        maxItems: args.max_items as number | undefined,
        cursor: args.cursor as string | undefined,
      })
  );

  jsonTool(
    server,
    "list_activity",
    {
      title: "List activity feed",
      description: "Returns the authenticated account's activity feed.",
      schema: { limit: z.number().int().min(1).max(200).optional() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => ctx.api.activity((args.limit as number | undefined) ?? 25)
  );

  jsonTool(
    server,
    "search_users",
    {
      title: "Search users",
      description: "Searches SoundCloud users.",
      schema: {
        query: z.string().min(1).max(500),
        limit: paging.limit,
        max_items: paging.max_items,
        cursor: paging.cursor,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      ctx.api.searchUsers(args.query as string, {
        limit: args.limit as number | undefined,
        maxItems: args.max_items as number | undefined,
        cursor: args.cursor as string | undefined,
      })
  );

  jsonTool(
    server,
    "search_playlists",
    {
      title: "Search playlists",
      description: "Searches SoundCloud playlists.",
      schema: {
        query: z.string().min(1).max(500),
        limit: paging.limit,
        max_items: paging.max_items,
        cursor: paging.cursor,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      ctx.api.searchPlaylists(args.query as string, {
        limit: args.limit as number | undefined,
        maxItems: args.max_items as number | undefined,
        cursor: args.cursor as string | undefined,
      })
  );

  jsonTool(
    server,
    "resolve_url",
    {
      title: "Resolve SoundCloud URL",
      description:
        "Resolves a soundcloud.com or on.soundcloud.com URL to its API resource (track, playlist or user).",
      schema: { url: z.string().url().max(1000) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => ctx.api.resolve(args.url as string)
  );
}
