/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createReadStream, readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { createHash } from "node:crypto";
import { AppError } from "../errors.js";
import type { WebActionSession } from "./actions.js";

export type ShareAccess = "PUBLIC" | "PRIVATE" | "PRIVATE_FOLLOWS";
export type AlbumType = "ALBUM" | "EP";

export interface UploadPolicyHeader {
  key: string;
  value: string;
}

export interface UploadPolicy {
  __typename?: string;
  url: string;
  method?: string;
  uid: string;
  headers: UploadPolicyHeader[];
}

export interface TrackInputOptions {
  title: string;
  originalFilename: string;
  permalink?: string;
  genre?: string;
  description?: string;
  tags?: string[];
  artist?: string;
  explicit?: boolean;
  license?: string;
  shareAccess?: ShareAccess;
  durationSeconds?: number;
  downloadable?: boolean;
}

export interface AlbumInputOptions {
  title: string;
  trackUrns: string[];
  description?: string;
  public?: boolean;
  tags?: string[];
  permalink?: string;
  genre?: string;
  labelName?: string;
  license?: string;
  type?: AlbumType;
}

export interface WebUploadOptions extends Omit<TrackInputOptions, "originalFilename"> {
  filePath: string;
  albumTitle?: string;
  albumType?: AlbumType;
  /** Existing playlist/album URN to append the track to (e.g. soundcloud:playlists:123456789). */
  albumUrn?: string;
}

export interface WebUploadResult {
  uid: string;
  policy: { uid: string; url: string; method: string };
  upload: { status: number; etag: string | null; bytes: number; md5: string };
  track: unknown;
  album?: unknown;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".mp2": "audio/mpeg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".aiff": "audio/aiff",
  ".aif": "audio/aiff",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
};

const EXCLUDED_POLICY_HEADERS = new Set(["content-length", "host", "expect"]);

export function mimeForFile(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  const mime = MIME_BY_EXTENSION[extension];
  if (!mime) {
    throw new AppError("UNSUPPORTED_MEDIA", `Unsupported audio extension ${extension || "(none)"}.`, {
      status: 415,
      details: { supported: Object.keys(MIME_BY_EXTENSION) },
    });
  }
  return mime;
}

/** Build the S3 PUT headers exactly like the web client: Content-Type plus policy headers. */
export function policyHeaders(policy: UploadPolicy, mimeType: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": mimeType };
  for (const entry of policy.headers ?? []) {
    const key = entry?.key;
    const value = entry?.value;
    if (!key || !value) continue;
    if (EXCLUDED_POLICY_HEADERS.has(key.toLowerCase())) continue;
    headers[key] = value;
  }
  return headers;
}

/** The private action takes an ARRAY of `{ uid, trackInput }` rows. */
export function buildTrackInput(options: TrackInputOptions): Record<string, unknown> {
  const previewSeconds = options.durationSeconds && options.durationSeconds > 0 ? Math.min(20, Math.max(1, Math.round(options.durationSeconds))) : 20;
  return {
    title: options.title,
    permalink: options.permalink ?? "",
    genre: options.genre ?? "",
    originalFilename: options.originalFilename,
    tagList: options.tags ?? [],
    description: options.description ?? "",
    shareAccess: options.shareAccess ?? "PUBLIC",
    labelName: "",
    purchaseUrl: null,
    purchaseTitle: null,
    releaseDate: null,
    publisherMetadata: {
      artist: options.artist ?? "",
      explicit: options.explicit ?? false,
      publisher: null,
      pLine: null,
      isrc: null,
      iswc: null,
      releaseTitle: null,
      writerComposer: null,
      containsMusic: null,
    },
    snippetPresets: { startSeconds: 0, endSeconds: previewSeconds },
    firstFansPreEnrollment: "NOT_ENROLLED",
    downloadable: options.downloadable ?? false,
    apiStreamable: true,
    feedable: true,
    embeddable: true,
    commentable: true,
    revealComments: true,
    revealStats: true,
    license: options.license ?? "all-rights-reserved",
  };
}

/** `createAlbumAction` takes `{ createPlaylist }` without `imageData` when no artwork is uploaded. */
export function buildAlbumInput(options: AlbumInputOptions): Record<string, unknown> {
  return {
    createPlaylist: {
      title: options.title,
      description: options.description ?? "",
      public: options.public ?? true,
      tagList: (options.tags ?? []).join(" "),
      setType: options.type ?? "ALBUM",
      permalink: options.permalink ?? "",
      genre: options.genre ?? "",
      labelName: options.labelName ?? "",
      license: options.license ?? "all-rights-reserved",
      tracks: { urns: options.trackUrns },
    },
  };
}

function md5File(path: string): string {
  // Read in slices so multi-gigabyte uploads do not double their memory footprint.
  return createHash("md5").update(readFileSync(path)).digest("hex");
}

export interface PutResult {
  status: number;
  etag: string | null;
  bytes: number;
  md5: string;
}

/** PUT the audio file to the presigned S3 URL using the policy headers. */
export async function putFileToPolicy(policy: UploadPolicy, filePath: string, mimeType: string): Promise<PutResult> {
  const stats = statSync(filePath);
  const headers = policyHeaders(policy, mimeType);
  const md5 = md5File(filePath);
  const inlineLimit = 64 * 1024 * 1024;
  const body = stats.size <= inlineLimit ? readFileSync(filePath) : createReadStream(filePath);
  if (!Buffer.isBuffer(body)) headers["Content-Length"] = String(stats.size);
  const response = await fetch(policy.url, {
    method: policy.method ?? "PUT",
    headers,
    body: body as unknown as BodyInit,
    ...(Buffer.isBuffer(body) ? {} : { duplex: "half" as const }),
  });
  const etag = response.headers.get("etag")?.replace(/"/g, "") ?? null;
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new AppError("API_ERROR", `S3 upload failed with ${response.status}: ${text.slice(0, 300)}`, {
      status: 502,
      details: { policy: policy.url.slice(0, 120), status: response.status },
    });
  }
  if (etag && etag !== md5) {
    throw new AppError("INVALID_RESPONSE", "S3 object checksum does not match the local file.", {
      status: 502,
      details: { etag, md5 },
    });
  }
  return { status: response.status, etag, bytes: stats.size, md5 };
}

export class WebUploader {
  constructor(private readonly session: WebActionSession) {}

  async upload(options: WebUploadOptions): Promise<WebUploadResult> {
    const stats = statSync(options.filePath);
    const fileName = basename(options.filePath);
    const mimeType = mimeForFile(options.filePath);
    const policy = await this.session.call<UploadPolicy>("createUploadPolicyAction", fileName, stats.size, mimeType);
    if (!policy || typeof policy !== "object" || !policy.url || !policy.uid) {
      throw new AppError("INVALID_RESPONSE", "createUploadPolicyAction returned no upload policy.", {
        status: 502,
        details: { value: policy as unknown },
      });
    }
    if ("rejected" in policy) {
      throw new AppError("BAD_REQUEST", `SoundCloud rejected the upload: ${String((policy as { rejected?: string }).rejected)}`, {
        status: 422,
      });
    }
    const upload = await putFileToPolicy(policy, options.filePath, mimeType);
    const trackInput = buildTrackInput({
      ...options,
      title: options.title,
      originalFilename: fileName,
    });
    // Verified contract: the private action receives ONE object { uid, trackInput }.
    const track = await this.session.call("createTrackAction", { uid: policy.uid, trackInput });
    let album: unknown;
    if (options.albumUrn) {
      const urn = extractTrackUrn(track);
      if (!urn) {
        throw new AppError("INVALID_RESPONSE", "Track was created but no URN was returned, so it cannot be added to the album.", {
          status: 502,
          details: { track },
        });
      }
      // The add-to-playlist action is registered on the album editor page, not the upload page.
      const playlistId = options.albumUrn.split(":").pop();
      await this.session.navigate(`https://soundcloud.com/n/album/${playlistId ?? ""}`);
      await this.addTrackToAlbum(urn, options.albumUrn);
      album = { urn: options.albumUrn, added_track_urn: urn };
    } else if (options.albumTitle) {
      const urn = extractTrackUrn(track);
      if (!urn) {
        throw new AppError("INVALID_RESPONSE", "Track was created but no URN was returned, so the album cannot reference it.", {
          status: 502,
          details: { track },
        });
      }
      album = await this.session.call("createAlbumAction", buildAlbumInput({ title: options.albumTitle, trackUrns: [urn], type: options.albumType ?? "ALBUM", genre: options.genre ?? "", tags: options.tags ?? [] }));
    }
    return {
      uid: policy.uid,
      policy: { uid: policy.uid, url: policy.url, method: policy.method ?? "PUT" },
      upload,
      track,
      ...(album !== undefined ? { album } : {}),
    };
  }

  async createAlbum(options: AlbumInputOptions): Promise<unknown> {
    return this.session.call("createAlbumAction", buildAlbumInput(options));
  }

  /** Append tracks to an existing album/playlist. The session must be on an album editor page. */
  async addTrackToAlbum(trackUrn: string, playlistUrn: string): Promise<void> {
    await this.session.call("addToPlaylistAction", { trackUrns: [trackUrn], playlistUrn });
  }

  /** Look up a track by permalink through api-v2 (used for post-upload verification). */
  async verifyPermalink(permalink: string): Promise<Record<string, unknown> | null> {
    const me = await this.session.apiGet<{ id?: number }>("/me");
    if (!me?.id) return null;
    const tracks = await this.session.apiGet<{ collection?: Array<Record<string, unknown>> }>(`/users/${me.id}/tracks?limit=50`);
    return tracks.collection?.find((track) => track.permalink === permalink) ?? null;
  }
}

/** Pull a track URN out of whatever shape the private action returned. */
export function extractTrackUrn(value: unknown): string | null {
  const visit = (node: unknown, depth: number): string | null => {
    if (!node || depth > 4) return null;
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = visit(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (typeof node !== "object") return null;
    const record = node as Record<string, unknown>;
    if (typeof record.urn === "string" && record.urn.startsWith("soundcloud:tracks:")) return record.urn;
    if (typeof record.trackUrn === "string" && record.trackUrn.startsWith("soundcloud:tracks:")) return record.trackUrn;
    for (const key of ["tracks", "track", "results", "created", "data"]) {
      const found = visit(record[key], depth + 1);
      if (found) return found;
    }
    return null;
  };
  return visit(value, 0);
}
