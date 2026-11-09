/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Id3Edits } from "../soundcloud/id3.js";
import type { ToolContext } from "./context.js";
import { jsonTool } from "./helpers.js";

const tagsSchema = {
  title: z.string().max(400).optional(),
  artist: z.string().max(400).optional(),
  album: z.string().max(400).optional(),
  album_artist: z.string().max(400).optional(),
  genre: z.string().max(200).optional(),
  year: z.string().max(30).optional().describe("Year or ISO date (yyyy-mm-dd)"),
  track: z.string().max(30).optional().describe("Track number, e.g. 3/12"),
  disc: z.string().max(30).optional().describe("Disc number, e.g. 1/2"),
  comment: z.string().max(4000).optional(),
  composer: z.string().max(400).optional(),
  bpm: z.string().max(10).optional(),
  isrc: z.string().max(30).optional(),
  lyrics: z.string().max(20000).optional(),
  copyright: z.string().max(400).optional(),
  publisher: z.string().max(400).optional(),
  encoded_by: z.string().max(200).optional(),
};

function editsFrom(args: Record<string, unknown>): Id3Edits {
  return {
    title: args.title as string | undefined,
    artist: args.artist as string | undefined,
    album: args.album as string | undefined,
    albumArtist: args.album_artist as string | undefined,
    genre: args.genre as string | undefined,
    year: args.year as string | undefined,
    track: args.track as string | undefined,
    disc: args.disc as string | undefined,
    comment: args.comment as string | undefined,
    composer: args.composer as string | undefined,
    bpm: args.bpm as string | undefined,
    isrc: args.isrc as string | undefined,
    lyrics: args.lyrics as string | undefined,
    copyright: args.copyright as string | undefined,
    publisher: args.publisher as string | undefined,
    encodedBy: args.encoded_by as string | undefined,
  };
}

export function registerAudioTools(server: McpServer, ctx: ToolContext): void {
  jsonTool(
    server,
    "audio_probe",
    {
      title: "Probe an audio file",
      description:
        "Returns technical info (duration, bitrate, sample rate, channels, codec) and ID3 tags for a file inside SC_MEDIA_DIRS.",
      schema: { file_path: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => ctx.audio.probe(args.file_path as string)
  );

  jsonTool(
    server,
    "read_audio_tags",
    {
      title: "Read MP3 tags",
      description: "Reads ID3v2 tags and artwork metadata without returning image bytes unless requested.",
      schema: {
        file_path: z.string().min(1),
        include_artwork_data: z.boolean().optional().describe("Return base64 artwork (can be large)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      ctx.audio.readTags(args.file_path as string, (args.include_artwork_data as boolean | undefined) ?? false)
  );

  jsonTool(
    server,
    "edit_audio_tags",
    {
      title: "Edit MP3 tags and artwork",
      description:
        "Writes ID3v2.4 tags (title, artist, album, album artist, genre, year, track, disc, comment, composer, BPM, ISRC, lyrics, copyright, publisher) and replaces/removes embedded APIC artwork. " +
        "The audio payload is streamed; unknown frames are preserved. In-place edits create a `.bak` backup by default.",
      schema: {
        file_path: z.string().min(1),
        ...tagsSchema,
        artwork_path: z.string().optional().describe("Image file inside SC_MEDIA_DIRS"),
        remove_artwork: z.boolean().optional(),
        output_path: z.string().optional().describe("New file inside SC_MEDIA_DIRS; default edits in place"),
        backup: z.boolean().optional().describe("Create <file>.bak for in-place edits (default true)"),
      },
      annotations: { idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      ctx.audio.updateTags({
        filePath: args.file_path as string,
        edits: editsFrom(args),
        ...(args.artwork_path ? { artworkPath: args.artwork_path as string } : {}),
        ...(args.remove_artwork ? { removeArtwork: true } : {}),
        ...(args.output_path ? { outputPath: args.output_path as string } : {}),
        backup: (args.backup as boolean | undefined) ?? true,
      })
  );

  jsonTool(
    server,
    "change_audio_speed",
    {
      title: "Change audio speed / tempo / pitch",
      description:
        "Re-encodes a local audio file with ffmpeg. mode=tempo changes speed without pitch; mode=pitch shifts pitch without duration; mode=speed is tape-style (both change); mode=both accepts ratio and pitch. " +
        "Uses rubberband when available, otherwise atempo/asetrate. SoundCloud cannot replace uploaded audio, so upload the result as a new track.",
      schema: {
        file_path: z.string().min(1),
        ratio: z.number().min(0.25).max(4).default(1.25).describe("Speed/tempo multiplier"),
        mode: z.enum(["tempo", "pitch", "speed", "both"]).default("tempo"),
        pitch: z.number().min(0.25).max(4).optional().describe("Pitch multiplier for mode=both"),
        algorithm: z.enum(["auto", "rubberband", "atempo"]).default("auto"),
        bitrate_kbps: z.number().int().min(64).max(320).optional(),
        output_path: z.string().optional(),
        overwrite: z.boolean().optional(),
        keep_tags: z.boolean().optional().describe("Copy ID3 tags/artwork to the output (default true)"),
        ...tagsSchema,
      },
      annotations: { idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const tagEdits = editsFrom(args);
      return ctx.audio.process({
        filePath: args.file_path as string,
        operation: args.mode as "tempo" | "pitch" | "speed" | "both",
        ratio: args.ratio as number,
        ...(args.pitch !== undefined ? { pitch: args.pitch as number } : {}),
        algorithm: args.algorithm as "auto" | "rubberband" | "atempo",
        ...(args.bitrate_kbps !== undefined ? { bitrateKbps: args.bitrate_kbps as number } : {}),
        ...(args.output_path ? { outputPath: args.output_path as string } : {}),
        overwrite: (args.overwrite as boolean | undefined) ?? false,
        keepTags: (args.keep_tags as boolean | undefined) ?? true,
        ...(Object.values(tagEdits).some((value) => value !== undefined) ? { tagEdits } : {}),
      });
    }
  );

  jsonTool(
    server,
    "normalize_audio",
    {
      title: "Normalize loudness (EBU R128)",
      description:
        "Applies ffmpeg loudnorm. Defaults: -14 LUFS integrated, -1 dBTP true peak, LRA 11 — a common streaming target.",
      schema: {
        file_path: z.string().min(1),
        target_lufs: z.number().min(-24).max(-5).optional(),
        true_peak: z.number().min(-9).max(0).optional(),
        lra: z.number().min(1).max(50).optional(),
        output_path: z.string().optional(),
        overwrite: z.boolean().optional(),
      },
      annotations: { idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      ctx.audio.process({
        filePath: args.file_path as string,
        operation: "normalize",
        ...(args.target_lufs !== undefined ? { targetLufs: args.target_lufs as number } : {}),
        ...(args.true_peak !== undefined ? { truePeak: args.true_peak as number } : {}),
        ...(args.lra !== undefined ? { lra: args.lra as number } : {}),
        ...(args.output_path ? { outputPath: args.output_path as string } : {}),
        overwrite: (args.overwrite as boolean | undefined) ?? false,
      })
  );

  jsonTool(
    server,
    "trim_audio",
    {
      title: "Trim audio",
      description: "Cuts a section with ffmpeg atrim; the output keeps ID3 tags and artwork.",
      schema: {
        file_path: z.string().min(1),
        start_seconds: z.number().min(0).default(0),
        end_seconds: z.number().min(0).optional(),
        output_path: z.string().optional(),
        overwrite: z.boolean().optional(),
      },
      annotations: { idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      ctx.audio.process({
        filePath: args.file_path as string,
        operation: "trim",
        startSeconds: (args.start_seconds as number | undefined) ?? 0,
        ...(args.end_seconds !== undefined ? { endSeconds: args.end_seconds as number } : {}),
        ...(args.output_path ? { outputPath: args.output_path as string } : {}),
        overwrite: (args.overwrite as boolean | undefined) ?? false,
      })
  );

  jsonTool(
    server,
    "convert_audio",
    {
      title: "Convert audio format",
      description: "Converts to MP3 (libmp3lame), WAV (pcm_s16le) or FLAC. MP3 defaults to 320 kbps.",
      schema: {
        file_path: z.string().min(1),
        format: z.enum(["mp3", "wav", "flac"]),
        bitrate_kbps: z.number().int().min(64).max(320).optional(),
        output_path: z.string().optional(),
        overwrite: z.boolean().optional(),
      },
      annotations: { idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      ctx.audio.process({
        filePath: args.file_path as string,
        operation: "convert",
        format: args.format as "mp3" | "wav" | "flac",
        ...(args.bitrate_kbps !== undefined ? { bitrateKbps: args.bitrate_kbps as number } : {}),
        ...(args.output_path ? { outputPath: args.output_path as string } : {}),
        overwrite: (args.overwrite as boolean | undefined) ?? false,
      })
  );
}
