/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LICENSES, parseStreamExpiry, type License, type UploadMetadata } from "../soundcloud/api.js";
import { toUrn } from "../util/ids.js";
import type { ToolContext } from "./context.js";
import { idSchema, jsonTool, progressReporter, stringOrStringArray } from "./helpers.js";

const licenseSchema = z.enum(LICENSES as unknown as [License, ...License[]]);

function trackUrn(value: unknown): string {
  return toUrn("tracks", value as string | number);
}

export function registerTrackTools(server: McpServer, ctx: ToolContext): void {
  jsonTool(
    server,
    "search_tracks",
    {
      title: "Search SoundCloud tracks",
      description:
        "Searches tracks with linked_partitioning pagination. Pass `cursor` from a previous response to fetch the next page.",
      schema: {
        query: z.string().min(1).max(500).optional().describe("Search keywords"),
        genres: z.string().max(500).optional().describe("Comma-separated genres"),
        tags: z.string().max(500).optional().describe("Comma-separated tags"),
        bpm_from: z.number().min(0).max(400).optional(),
        bpm_to: z.number().min(0).max(400).optional(),
        duration_from_ms: z.number().int().min(0).optional(),
        duration_to_ms: z.number().int().min(0).optional(),
        created_at_from: z.string().max(30).optional().describe("yyyy-mm-dd hh:mm:ss"),
        created_at_to: z.string().max(30).optional(),
        access: z.enum(["playable", "preview", "blocked"]).optional(),
        limit: z.number().int().min(1).max(200).optional().describe("Page size (default 50)"),
        max_items: z.number().int().min(1).max(1000).optional().describe("Total results to collect"),
        cursor: z.string().url().optional().describe("next_href from a previous page"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      ctx.api.searchTracks({
        query: args.query as string | undefined,
        genres: args.genres as string | undefined,
        tags: args.tags as string | undefined,
        bpmFrom: args.bpm_from as number | undefined,
        bpmTo: args.bpm_to as number | undefined,
        durationFrom: args.duration_from_ms as number | undefined,
        durationTo: args.duration_to_ms as number | undefined,
        createdAtFrom: args.created_at_from as string | undefined,
        createdAtTo: args.created_at_to as string | undefined,
        access: args.access as string | undefined,
        limit: args.limit as number | undefined,
        maxItems: args.max_items as number | undefined,
        cursor: args.cursor as string | undefined,
      })
  );

  jsonTool(
    server,
    "get_track",
    {
      title: "Get track",
      description: "Returns one track by numeric id or soundcloud:tracks:<id> URN.",
      schema: { track_id: idSchema("Track id or soundcloud:tracks:<id> URN") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => ctx.api.track(trackUrn(args.track_id))
  );

  jsonTool(
    server,
    "list_my_tracks",
    {
      title: "List my tracks",
      description: "Lists the authenticated user's tracks with pagination.",
      schema: {
        limit: z.number().int().min(1).max(200).optional(),
        max_items: z.number().int().min(1).max(2000).optional(),
        cursor: z.string().url().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      ctx.api.myTracks({
        limit: args.limit as number | undefined,
        maxItems: args.max_items as number | undefined,
        cursor: args.cursor as string | undefined,
      })
  );

  jsonTool(
    server,
    "update_track",
    {
      title: "Update track metadata",
      description:
        "Updates track metadata (JSON PUT /tracks/{urn}). To change artwork use upload_track_artwork; audio cannot be replaced.",
      schema: {
        track_id: idSchema("Track id or URN"),
        title: z.string().min(1).max(300).optional(),
        description: z.string().max(4000).optional(),
        genre: z.string().max(200).optional(),
        tags: stringOrStringArray("Tags as an array or space-separated string").optional(),
        label_name: z.string().max(200).optional(),
        release_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "yyyy-mm-dd").optional(),
        isrc: z.string().max(30).optional(),
        permalink: z.string().max(200).optional(),
        purchase_url: z.string().url().max(500).optional(),
        purchase_title: z.string().max(200).optional(),
        sharing: z.enum(["public", "private"]).optional(),
        downloadable: z.boolean().optional(),
        streamable: z.boolean().optional(),
        commentable: z.boolean().optional(),
        embeddable_by: z.enum(["all", "me", "none"]).optional(),
        license: licenseSchema.optional(),
        metadata_artist: z.string().max(200).optional(),
        reveal_stats: z.boolean().optional(),
        reveal_comments: z.boolean().optional(),
      },
      annotations: { idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      ctx.api.updateTrack(trackUrn(args.track_id), {
        title: args.title as string | undefined,
        description: args.description as string | undefined,
        genre: args.genre as string | undefined,
        tags: args.tags as string | string[] | undefined,
        labelName: args.label_name as string | undefined,
        releaseDate: args.release_date as string | undefined,
        isrc: args.isrc as string | undefined,
        permalink: args.permalink as string | undefined,
        purchaseUrl: args.purchase_url as string | undefined,
        purchaseTitle: args.purchase_title as string | undefined,
        sharing: args.sharing as "public" | "private" | undefined,
        downloadable: args.downloadable as boolean | undefined,
        streamable: args.streamable as boolean | undefined,
        commentable: args.commentable as boolean | undefined,
        embeddableBy: args.embeddable_by as "all" | "me" | "none" | undefined,
        license: args.license as License | undefined,
        metadataArtist: args.metadata_artist as string | undefined,
        revealStats: args.reveal_stats as boolean | undefined,
        revealComments: args.reveal_comments as boolean | undefined,
      })
  );

  jsonTool(
    server,
    "delete_track",
    {
      title: "Delete track",
      description: "Permanently deletes a track. This cannot be undone.",
      schema: { track_id: idSchema("Track id or URN") },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const urn = trackUrn(args.track_id);
      await ctx.api.deleteTrack(urn);
      return { success: true, track_urn: urn, message: "Track deleted." };
    }
  );

  jsonTool(
    server,
    "upload_track",
    {
      title: "Upload MP3/audio track",
      description:
        "Streams an audio file to POST /tracks as multipart/form-data (no full-file buffering). " +
        "MP3 ID3 tags can auto-fill title/artist/genre/comment/year and embedded artwork. " +
        "SoundCloud limits: 4 GB and 24 h per track; encoding is asynchronous after a 201 response.",
      schema: {
        file_path: z.string().min(1).describe("Audio path inside SC_MEDIA_DIRS"),
        title: z.string().min(1).max(300).optional(),
        artist: z.string().max(200).optional().describe("Maps to track[artist]; returned as metadata_artist"),
        description: z.string().max(4000).optional(),
        genre: z.string().max(200).optional(),
        tags: stringOrStringArray("Tags as an array or space-separated string").optional(),
        label_name: z.string().max(200).optional(),
        release_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        isrc: z.string().max(30).optional(),
        permalink: z.string().max(200).optional(),
        purchase_url: z.string().url().max(500).optional(),
        purchase_title: z.string().max(200).optional(),
        sharing: z.enum(["public", "private"]).default("private"),
        downloadable: z.boolean().optional(),
        streamable: z.boolean().optional(),
        commentable: z.boolean().optional(),
        embeddable_by: z.enum(["all", "me", "none"]).optional(),
        license: licenseSchema.optional(),
        auto_tag: z.boolean().default(true).describe("Read MP3 ID3 tags for missing metadata"),
        artwork_path: z.string().optional().describe("Optional artwork file inside SC_MEDIA_DIRS"),
        attach_artwork: z.boolean().default(true).describe("Upload embedded ID3 artwork when available"),
      },
      annotations: { idempotentHint: false, openWorldHint: true },
    },
    async (args, extra) => {
      const filePath = args.file_path as string;
      const resolved = ctx.uploads.resolvePath(filePath, "audio");
      const metadata: Omit<UploadMetadata, "title"> & { title?: string } = {
        title: args.title as string | undefined,
        artist: args.artist as string | undefined,
        description: args.description as string | undefined,
        genre: args.genre as string | undefined,
        tags: args.tags as string | string[] | undefined,
        labelName: args.label_name as string | undefined,
        releaseDate: args.release_date as string | undefined,
        isrc: args.isrc as string | undefined,
        permalink: args.permalink as string | undefined,
        purchaseUrl: args.purchase_url as string | undefined,
        purchaseTitle: args.purchase_title as string | undefined,
        sharing: (args.sharing as "public" | "private" | undefined) ?? "private",
        downloadable: args.downloadable as boolean | undefined,
        streamable: args.streamable as boolean | undefined,
        commentable: args.commentable as boolean | undefined,
        embeddableBy: args.embeddable_by as "all" | "me" | "none" | undefined,
        license: args.license as License | undefined,
      };
      const result = await ctx.uploads.upload({
        filePath,
        metadata,
        autoTag: (args.auto_tag as boolean | undefined) ?? true,
        ...(args.artwork_path ? { artworkPath: args.artwork_path as string } : {}),
        attachArtwork: (args.attach_artwork as boolean | undefined) ?? true,
        onProgress: progressReporter(extra, resolved.size),
        signal: extra.signal,
      });
      return {
        track: result.track,
        warnings: result.warnings,
        file: result.file,
        metadata_used: result.metadata,
        note: "SoundCloud transcodes asynchronously; the 201 response already contains the track.",
      };
    }
  );

  jsonTool(
    server,
    "upload_track_artwork",
    {
      title: "Upload track artwork",
      description: "Uploads/replaces track artwork with PUT /tracks/{urn} multipart (artwork_data).",
      schema: {
        track_id: idSchema("Track id or URN"),
        file_path: z.string().min(1).describe("Image path inside SC_MEDIA_DIRS"),
      },
      annotations: { idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const urn = trackUrn(args.track_id);
      const resolved = ctx.uploads.resolvePath(args.file_path as string, "image");
      const { makeFilePart } = await import("../soundcloud/multipart.js");
      const track = await ctx.api.uploadArtwork(urn, makeFilePart(resolved.path));
      return { track, note: "Artwork uploaded." };
    }
  );

  jsonTool(
    server,
    "get_stream_url",
    {
      title: "Get stream URLs",
      description:
        "Returns every stream URL SoundCloud exposes for the track (HLS AAC/MP3, preview, legacy HTTP if present), " +
        "the track access status, and the real expiry parsed from the signed URL when available.",
      schema: { track_id: idSchema("Track id or URN") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const urn = trackUrn(args.track_id);
      const [track, streams] = await Promise.all([ctx.api.track(urn), ctx.api.getStreamUrls(urn)]);
      const formats: Record<string, string> = {};
      for (const [key, value] of Object.entries(streams)) {
        if (typeof value === "string" && /^https?:\/\//.test(value)) formats[key] = value;
      }
      const primary =
        streams.hls_mp3_128_url ??
        streams.hls_aac_160_url ??
        streams.http_mp3_128_url ??
        streams.https_mp3_128_url ??
        streams.preview_mp3_128_url ??
        null;
      const expiresAt = primary ? parseStreamExpiry(primary) : null;
      return {
        track_urn: track.urn ?? urn,
        title: track.title,
        access: track.access ?? null,
        streamable: track.streamable ?? null,
        formats,
        primary_stream_url: primary,
        expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
        expires_in_seconds: expiresAt ? Math.max(0, Math.round((expiresAt - Date.now()) / 1000)) : null,
        note: "Signed URLs require the same authenticated session; do not re-host or redistribute.",
      };
    }
  );

  jsonTool(
    server,
    "get_track_comments",
    {
      title: "Get track comments",
      description: "Lists comments on a track with pagination.",
      schema: {
        track_id: idSchema("Track id or URN"),
        limit: z.number().int().min(1).max(200).optional(),
        max_items: z.number().int().min(1).max(1000).optional(),
        cursor: z.string().url().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      ctx.api.comments(trackUrn(args.track_id), {
        limit: args.limit as number | undefined,
        maxItems: args.max_items as number | undefined,
        cursor: args.cursor as string | undefined,
      })
  );

  jsonTool(
    server,
    "post_comment",
    {
      title: "Post track comment",
      description: "Posts a comment (optionally at a timestamp in milliseconds) on a track.",
      schema: {
        track_id: idSchema("Track id or URN"),
        body: z.string().min(1).max(4000),
        timestamp_ms: z.number().int().min(0).optional(),
      },
      annotations: { idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      ctx.api.postComment(
        trackUrn(args.track_id),
        args.body as string,
        args.timestamp_ms as number | undefined
      )
  );
}
