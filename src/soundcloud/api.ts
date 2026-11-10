/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { TokenService } from "../auth/tokenService.js";
import { AppError } from "../errors.js";
import { HttpClient } from "./http.js";
import { createMultipart, makeFilePart, type FilePart } from "./multipart.js";
import type {
  Paged,
  QueryParams,
  SoundCloudComment,
  SoundCloudMe,
  SoundCloudPlaylist,
  SoundCloudTrack,
  SoundCloudUser,
  StreamUrls,
} from "./types.js";

export const LICENSES = [
  "no-rights-reserved",
  "all-rights-reserved",
  "cc-by",
  "cc-by-nc",
  "cc-by-nd",
  "cc-by-sa",
  "cc-by-nc-nd",
  "cc-by-nc-sa",
] as const;

export type License = (typeof LICENSES)[number];

export interface UploadMetadata {
  title: string;
  artist?: string;
  description?: string;
  genre?: string;
  tags?: string | string[];
  labelName?: string;
  releaseDate?: string;
  isrc?: string;
  permalink?: string;
  purchaseUrl?: string;
  purchaseTitle?: string;
  sharing?: "public" | "private";
  downloadable?: boolean;
  streamable?: boolean;
  commentable?: boolean;
  embeddableBy?: "all" | "me" | "none";
  license?: License;
  revealStats?: boolean;
  revealComments?: boolean;
}

export interface TrackUpdate {
  title?: string;
  description?: string;
  genre?: string;
  tags?: string | string[];
  labelName?: string;
  releaseDate?: string;
  isrc?: string;
  permalink?: string;
  purchaseUrl?: string;
  purchaseTitle?: string;
  sharing?: "public" | "private";
  downloadable?: boolean;
  streamable?: boolean;
  commentable?: boolean;
  embeddableBy?: "all" | "me" | "none";
  license?: License;
  metadataArtist?: string;
  revealStats?: boolean;
  revealComments?: boolean;
}

export interface PlaylistFields {
  title?: string;
  description?: string;
  sharing?: "public" | "private";
  genre?: string;
  tags?: string | string[];
  labelName?: string;
  releaseDate?: string;
  permalink?: string;
  purchaseUrl?: string;
  purchaseTitle?: string;
  setType?: "album" | "playlist";
  ean?: string;
  license?: string;
}

export interface PaginationOptions {
  limit?: number;
  cursor?: string | null;
  maxItems?: number;
}

function tagsToString(tags: string | string[] | undefined): string | undefined {
  if (tags === undefined) return undefined;
  if (Array.isArray(tags)) return tags.map((tag) => tag.trim()).filter(Boolean).join(" ");
  return tags;
}

function normalizeTrackEntry(entry: unknown): string | null {
  if (typeof entry === "number") return `soundcloud:tracks:${entry}`;
  if (typeof entry === "string") {
    return entry.startsWith("soundcloud:tracks:") ? entry : null;
  }
  if (entry && typeof entry === "object") {
    const record = entry as { urn?: unknown; id?: unknown };
    if (typeof record.urn === "string" && record.urn.startsWith("soundcloud:tracks:")) return record.urn;
    if (typeof record.id === "number") return `soundcloud:tracks:${record.id}`;
  }
  return null;
}

export function trackUrnsFromPlaylist(playlist: SoundCloudPlaylist): string[] {
  return (playlist.tracks ?? [])
    .map((entry) => normalizeTrackEntry(entry))
    .filter((urn): urn is string => typeof urn === "string");
}

/** Extract expiry (epoch ms) from a signed SoundCloud stream URL when present. */
export function parseStreamExpiry(url: string): number | null {
  try {
    const parsed = new URL(url);
    const expires = parsed.searchParams.get("Expires");
    if (expires && /^\d+$/.test(expires)) return Number(expires) * 1000;

    const policy = parsed.searchParams.get("Policy");
    if (policy) {
      const json = JSON.parse(Buffer.from(policy, "base64").toString("utf8")) as {
        Statement?: Array<{ Condition?: { DateLessThan?: { epochTime?: number } } }>;
      };
      const epoch = json.Statement?.[0]?.Condition?.DateLessThan?.epochTime;
      if (typeof epoch === "number") return epoch * 1000;
    }

    const amzDate = parsed.searchParams.get("X-Amz-Date");
    const amzExpires = parsed.searchParams.get("X-Amz-Expires");
    if (amzDate && amzExpires && /^\d+$/.test(amzExpires)) {
      const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate);
      if (match) {
        const [, y, mo, d, h, mi, s] = match;
        const start = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
        return start + Number(amzExpires) * 1000;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function isAmbiguousUploadFailure(sentBytes: number, fileSize: number, error: unknown): boolean {
  if (!(error instanceof AppError)) return false;
  if (sentBytes < fileSize) return false;
  return (
    error.code === "TIMEOUT" ||
    error.code === "NETWORK" ||
    (error.code === "API_ERROR" && (error.options.status ?? 0) >= 500)
  );
}

export class SoundCloudApi {
  private readonly http: HttpClient;

  constructor(
    private readonly deps: {
      config: Config;
      logger: Logger;
      tokens: TokenService;
      getAccessToken: (options?: { forceRefresh?: boolean }) => Promise<string>;
      fetchImpl?: typeof fetch;
    }
  ) {
    this.http = new HttpClient({
      config: deps.config,
      logger: deps.logger,
      getAccessToken: deps.getAccessToken,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
  }

  // ── Identity ──────────────────────────────────────────────────────────────

  me(): Promise<SoundCloudMe> {
    return this.http.request<SoundCloudMe>("/me");
  }

  updateProfile(fields: Record<string, string | undefined>): Promise<SoundCloudUser> {
    const user: Record<string, string> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) user[key] = value;
    }
    if (Object.keys(user).length === 0) {
      throw new AppError("BAD_REQUEST", "No profile fields supplied.", { status: 400 });
    }
    return this.http.request<SoundCloudUser>("/me", { method: "PUT", json: { user } });
  }

  async uploadAvatar(filePath: string, signal?: AbortSignal): Promise<SoundCloudUser> {
    const file = makeFilePart(filePath);
    if (!file.contentType.startsWith("image/")) {
      throw new AppError("UNSUPPORTED_MEDIA", "Avatar must be a JPEG, PNG, GIF or WebP image.", { status: 415 });
    }
    const multipart = createMultipart({}, file, "user[avatar_data]");
    return this.http.request<SoundCloudUser>("/me", {
      method: "PUT",
      multipart,
      retryable: false,
      skipAuthRefresh: true,
      ...(signal ? { signal } : {}),
    });
  }

  quota(): Promise<{ unlimited: boolean; secondsUsed: number | null; secondsLeft: number | null }> {
    return this.me().then((me) => ({
      unlimited: me.quota?.unlimited_upload_quota ?? false,
      secondsUsed: me.quota?.upload_seconds_used ?? null,
      secondsLeft: me.upload_seconds_left ?? me.quota?.upload_seconds_left ?? null,
    }));
  }

  // ── Users ─────────────────────────────────────────────────────────────────

  user(urn: string): Promise<SoundCloudUser> {
    return this.http.request<SoundCloudUser>(`/users/${encodeURIComponent(urn)}`);
  }

  searchUsers(query: string, options: PaginationOptions = {}): Promise<Paged<SoundCloudUser>> {
    return this.http.paginate<SoundCloudUser>("/users", {
      query: { q: query },
      ...this.pagination(options),
    });
  }

  userTracks(urn: string, options: PaginationOptions = {}): Promise<Paged<SoundCloudTrack>> {
    return this.http.paginate<SoundCloudTrack>(`/users/${encodeURIComponent(urn)}/tracks`, {
      ...this.pagination(options),
    });
  }

  userPlaylists(urn: string, options: PaginationOptions = {}): Promise<Paged<SoundCloudPlaylist>> {
    return this.http.paginate<SoundCloudPlaylist>(`/users/${encodeURIComponent(urn)}/playlists`, {
      ...this.pagination(options),
    });
  }

  userFollowers(urn: string, options: PaginationOptions = {}): Promise<Paged<SoundCloudUser>> {
    return this.http.paginate<SoundCloudUser>(`/users/${encodeURIComponent(urn)}/followers`, {
      ...this.pagination(options),
    });
  }

  userFollowings(urn: string, options: PaginationOptions = {}): Promise<Paged<SoundCloudUser>> {
    return this.http.paginate<SoundCloudUser>(`/users/${encodeURIComponent(urn)}/followings`, {
      ...this.pagination(options),
    });
  }

  userLikes(urn: string, options: PaginationOptions = {}): Promise<Paged<SoundCloudTrack>> {
    return this.http.paginate<SoundCloudTrack>(`/users/${encodeURIComponent(urn)}/likes/tracks`, {
      ...this.pagination(options),
    });
  }

  follow(urn: string): Promise<unknown> {
    return this.http.request(`/me/followings/${encodeURIComponent(urn)}`, { method: "PUT" });
  }

  unfollow(urn: string): Promise<unknown> {
    return this.http.request(`/me/followings/${encodeURIComponent(urn)}`, { method: "DELETE" });
  }

  myFollowers(options: PaginationOptions = {}): Promise<Paged<SoundCloudUser>> {
    return this.http.paginate<SoundCloudUser>("/me/followers", { ...this.pagination(options) });
  }

  myFollowings(options: PaginationOptions = {}): Promise<Paged<SoundCloudUser>> {
    return this.http.paginate<SoundCloudUser>("/me/followings", { ...this.pagination(options) });
  }

  // ── Tracks ────────────────────────────────────────────────────────────────

  searchTracks(
    options: {
      query?: string;
      genres?: string;
      tags?: string;
      bpmFrom?: number;
      bpmTo?: number;
      durationFrom?: number;
      durationTo?: number;
      createdAtFrom?: string;
      createdAtTo?: string;
      access?: string;
      userIds?: string;
    } & PaginationOptions
  ): Promise<Paged<SoundCloudTrack>> {
    const query: QueryParams = {};
    if (options.query) query.q = options.query;
    if (options.genres) query.genres = options.genres;
    if (options.tags) query.tags = options.tags;
    if (options.bpmFrom !== undefined) query["bpm[from]"] = options.bpmFrom;
    if (options.bpmTo !== undefined) query["bpm[to]"] = options.bpmTo;
    if (options.durationFrom !== undefined) query["duration[from]"] = options.durationFrom;
    if (options.durationTo !== undefined) query["duration[to]"] = options.durationTo;
    if (options.createdAtFrom) query["created_at[from]"] = options.createdAtFrom;
    if (options.createdAtTo) query["created_at[to]"] = options.createdAtTo;
    if (options.access) query.access = options.access;
    if (options.userIds) query.user_ids = options.userIds;
    return this.http.paginate<SoundCloudTrack>("/tracks", {
      query,
      ...this.pagination(options),
    });
  }

  track(urn: string): Promise<SoundCloudTrack> {
    return this.http.request<SoundCloudTrack>(`/tracks/${encodeURIComponent(urn)}`);
  }

  myTracks(options: PaginationOptions = {}): Promise<Paged<SoundCloudTrack>> {
    return this.http.paginate<SoundCloudTrack>("/me/tracks", { ...this.pagination(options) });
  }

  updateTrack(urn: string, update: TrackUpdate): Promise<SoundCloudTrack> {
    const track: Record<string, unknown> = {};
    const assign = (key: string, value: unknown): void => {
      if (value !== undefined) track[key] = value;
    };
    assign("title", update.title);
    assign("description", update.description);
    assign("genre", update.genre);
    assign("tag_list", tagsToString(update.tags));
    assign("label_name", update.labelName);
    assign("release_date", update.releaseDate);
    assign("isrc", update.isrc);
    assign("permalink", update.permalink);
    assign("purchase_url", update.purchaseUrl);
    assign("purchase_title", update.purchaseTitle);
    assign("sharing", update.sharing);
    assign("downloadable", update.downloadable);
    assign("streamable", update.streamable);
    assign("commentable", update.commentable);
    assign("embeddable_by", update.embeddableBy);
    assign("license", update.license);
    assign("metadata_artist", update.metadataArtist);
    assign("reveal_stats", update.revealStats);
    assign("reveal_comments", update.revealComments);
    if (Object.keys(track).length === 0) {
      throw new AppError("BAD_REQUEST", "No track fields supplied.", { status: 400 });
    }
    return this.http.request<SoundCloudTrack>(`/tracks/${encodeURIComponent(urn)}`, {
      method: "PUT",
      json: { track },
    });
  }

  deleteTrack(urn: string): Promise<void> {
    return this.http
      .requestRaw(`/tracks/${encodeURIComponent(urn)}`, { method: "DELETE" })
      .then(() => undefined);
  }

  getStreamUrls(urn: string): Promise<StreamUrls> {
    return this.http.request<StreamUrls>(`/tracks/${encodeURIComponent(urn)}/streams`);
  }

  /**
   * Uploads a track with a streaming multipart body. Each retry rebuilds the
   * body because a stream cannot be replayed; 401 is handled by forcing a token
   * refresh before the retry.
   */
  async uploadTrack(
    metadata: UploadMetadata,
    file: FilePart,
    options: {
      signal?: AbortSignal;
      onProgress?: (sentBytes: number, totalBytes: number) => void;
      maxAttempts?: number;
    } = {}
  ): Promise<SoundCloudTrack> {
    const fields = this.uploadFields(metadata);
    const maxAttempts = options.maxAttempts ?? 3;
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(8_000, 750 * 2 ** attempt)));
        await this.deps.getAccessToken({ forceRefresh: true }).catch(() => undefined);
      }
      const progress = { sent: 0 };
      const multipart = createMultipart(fields, file, "track[asset_data]", (sent, total) => {
        progress.sent = sent;
        options.onProgress?.(sent, total);
      });
      try {
        return await this.http.request<SoundCloudTrack>("/tracks", {
          method: "POST",
          multipart,
          retryable: false,
          skipAuthRefresh: true,
          timeoutMs: Math.max(this.deps.config.sc.timeoutMs, 10 * 60_000),
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } catch (error) {
        lastError = error;
        if (error instanceof AppError) {
          // If the whole body reached SoundCloud and only the response was lost,
          // the track may already exist; retrying would create a duplicate.
          if (isAmbiguousUploadFailure(progress.sent, file.size, error)) {
            throw new AppError(
              "NETWORK",
              "The upload body was fully sent but SoundCloud did not confirm the track. Check the account before retrying to avoid a duplicate.",
              { status: 502, cause: error }
            );
          }
          const retryable =
            error.code === "TOKEN_EXPIRED" ||
            error.code === "RATE_LIMITED" ||
            error.code === "NETWORK" ||
            error.code === "TIMEOUT" ||
            (error.code === "API_ERROR" && (error.options.status ?? 0) >= 500);
          if (!retryable) throw error;
        } else {
          throw error;
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new AppError("API_ERROR", "Track upload failed after retries.", { status: 502 });
  }

  async uploadArtwork(urn: string, file: FilePart, signal?: AbortSignal): Promise<SoundCloudTrack> {
    const multipart = createMultipart({}, file, "track[artwork_data]");
    return this.http.request<SoundCloudTrack>(`/tracks/${encodeURIComponent(urn)}`, {
      method: "PUT",
      multipart,
      retryable: false,
      skipAuthRefresh: true,
      ...(signal ? { signal } : {}),
    });
  }

  // ── Comments ──────────────────────────────────────────────────────────────

  comments(urn: string, options: PaginationOptions = {}): Promise<Paged<SoundCloudComment>> {
    return this.http.paginate<SoundCloudComment>(`/tracks/${encodeURIComponent(urn)}/comments`, {
      ...this.pagination(options),
    });
  }

  postComment(urn: string, body: string, timestamp?: number): Promise<SoundCloudComment> {
    const comment: Record<string, unknown> = { body };
    if (timestamp !== undefined) comment.timestamp = timestamp;
    return this.http.request<SoundCloudComment>(`/tracks/${encodeURIComponent(urn)}/comments`, {
      method: "POST",
      json: { comment },
    });
  }

  // ── Likes / reposts ───────────────────────────────────────────────────────

  likeTrack(urn: string): Promise<unknown> {
    return this.http.request(`/likes/tracks/${encodeURIComponent(urn)}`, { method: "POST" });
  }

  unlikeTrack(urn: string): Promise<unknown> {
    return this.http.request(`/likes/tracks/${encodeURIComponent(urn)}`, { method: "DELETE" });
  }

  likePlaylist(urn: string): Promise<unknown> {
    return this.http.request(`/likes/playlists/${encodeURIComponent(urn)}`, { method: "POST" });
  }

  unlikePlaylist(urn: string): Promise<unknown> {
    return this.http.request(`/likes/playlists/${encodeURIComponent(urn)}`, { method: "DELETE" });
  }

  repostTrack(urn: string): Promise<unknown> {
    return this.http.request(`/reposts/tracks/${encodeURIComponent(urn)}`, { method: "POST" });
  }

  unrepostTrack(urn: string): Promise<unknown> {
    return this.http.request(`/reposts/tracks/${encodeURIComponent(urn)}`, { method: "DELETE" });
  }

  myLikes(options: PaginationOptions = {}): Promise<Paged<SoundCloudTrack>> {
    return this.http.paginate<SoundCloudTrack>("/me/likes/tracks", { ...this.pagination(options) });
  }

  myReposts(options: PaginationOptions = {}): Promise<Paged<SoundCloudTrack>> {
    return this.http.paginate<SoundCloudTrack>("/me/reposts/tracks", { ...this.pagination(options) });
  }

  activity(limit = 25): Promise<Paged<Record<string, unknown>>> {
    return this.http.paginate<Record<string, unknown>>("/me/activities", { maxItems: limit, pageSize: limit });
  }

  // ── Playlists ─────────────────────────────────────────────────────────────

  playlist(urn: string): Promise<SoundCloudPlaylist> {
    return this.http.request<SoundCloudPlaylist>(`/playlists/${encodeURIComponent(urn)}`);
  }

  myPlaylists(options: PaginationOptions = {}): Promise<Paged<SoundCloudPlaylist>> {
    return this.http.paginate<SoundCloudPlaylist>("/me/playlists", { ...this.pagination(options) });
  }

  searchPlaylists(query: string, options: PaginationOptions = {}): Promise<Paged<SoundCloudPlaylist>> {
    return this.http.paginate<SoundCloudPlaylist>("/playlists", {
      query: { q: query },
      ...this.pagination(options),
    });
  }

  createPlaylist(fields: PlaylistFields & { trackUrns?: string[] }): Promise<SoundCloudPlaylist> {
    if (!fields.title) throw new AppError("BAD_REQUEST", "Playlist title is required.", { status: 400 });
    const playlist: Record<string, unknown> = { title: fields.title };
    const assign = (key: string, value: unknown): void => {
      if (value !== undefined) playlist[key] = value;
    };
    assign("description", fields.description);
    assign("sharing", fields.sharing ?? "private");
    assign("genre", fields.genre);
    assign("tag_list", tagsToString(fields.tags));
    assign("label_name", fields.labelName);
    assign("release_date", fields.releaseDate);
    assign("permalink", fields.permalink);
    assign("purchase_url", fields.purchaseUrl);
    assign("purchase_title", fields.purchaseTitle);
    assign("set_type", fields.setType);
    assign("ean", fields.ean);
    assign("license", fields.license);
    if (fields.trackUrns && fields.trackUrns.length > 0) {
      playlist.tracks = fields.trackUrns.map((urn) => ({ urn }));
    }
    return this.http.request<SoundCloudPlaylist>("/playlists", {
      method: "POST",
      json: { playlist },
    });
  }

  updatePlaylist(
    urn: string,
    fields: PlaylistFields & { trackUrns?: string[]; clearTracks?: boolean }
  ): Promise<SoundCloudPlaylist> {
    const playlist: Record<string, unknown> = {};
    const assign = (key: string, value: unknown): void => {
      if (value !== undefined) playlist[key] = value;
    };
    assign("title", fields.title);
    assign("description", fields.description);
    assign("sharing", fields.sharing);
    assign("genre", fields.genre);
    assign("tag_list", tagsToString(fields.tags));
    assign("label_name", fields.labelName);
    assign("release_date", fields.releaseDate);
    assign("permalink", fields.permalink);
    assign("purchase_url", fields.purchaseUrl);
    assign("purchase_title", fields.purchaseTitle);
    assign("set_type", fields.setType);
    assign("ean", fields.ean);
    assign("license", fields.license);
    if (fields.trackUrns) playlist.tracks = fields.trackUrns.map((trackUrn) => ({ urn: trackUrn }));
    if (fields.clearTracks) playlist.tracks = [];
    if (Object.keys(playlist).length === 0) {
      throw new AppError("BAD_REQUEST", "No playlist fields supplied.", { status: 400 });
    }
    return this.http.request<SoundCloudPlaylist>(`/playlists/${encodeURIComponent(urn)}`, {
      method: "PUT",
      json: { playlist },
    });
  }

  deletePlaylist(urn: string): Promise<void> {
    return this.http
      .requestRaw(`/playlists/${encodeURIComponent(urn)}`, { method: "DELETE" })
      .then(() => undefined);
  }

  async uploadPlaylistArtwork(urn: string, file: FilePart, signal?: AbortSignal): Promise<SoundCloudPlaylist> {
    const multipart = createMultipart({}, file, "playlist[artwork_data]");
    try {
      return await this.http.request<SoundCloudPlaylist>(`/playlists/${encodeURIComponent(urn)}`, {
        method: "PUT",
        multipart,
        retryable: false,
        skipAuthRefresh: true,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (error instanceof AppError && (error.code === "BAD_REQUEST" || error.code === "API_ERROR")) {
        throw new AppError(
          "UNSUPPORTED_MEDIA",
          "SoundCloud rejected the playlist artwork update. The public API documents artwork_data only for playlist creation; " +
            `the server returned HTTP ${error.options.status ?? 400}.`,
          {
            status: 415,
            details: error.options.details,
          }
        );
      }
      throw error;
    }
  }

  async addTracks(urn: string, trackUrns: string[]): Promise<SoundCloudPlaylist> {
    const current = trackUrnsFromPlaylist(await this.playlist(urn));
    const merged = [...new Set([...current, ...trackUrns])];
    return this.updatePlaylist(urn, { trackUrns: merged });
  }

  async removeTrack(urn: string, trackUrn: string): Promise<SoundCloudPlaylist> {
    const current = trackUrnsFromPlaylist(await this.playlist(urn));
    return this.updatePlaylist(urn, { trackUrns: current.filter((item) => item !== trackUrn) });
  }

  async reorderPlaylist(urn: string, order: string[]): Promise<SoundCloudPlaylist> {
    const current = trackUrnsFromPlaylist(await this.playlist(urn));
    if (order.length !== current.length || new Set(order).size !== order.length) {
      throw new AppError(
        "BAD_REQUEST",
        `Reorder must list every track exactly once (playlist has ${current.length}).`,
        { status: 400 }
      );
    }
    for (const trackUrn of current) {
      if (!order.includes(trackUrn)) {
        throw new AppError("BAD_REQUEST", `Reorder is missing ${trackUrn}.`, { status: 400 });
      }
    }
    return this.updatePlaylist(urn, { trackUrns: order });
  }

  // ── Misc ──────────────────────────────────────────────────────────────────

  resolve(url: string): Promise<SoundCloudTrack | SoundCloudPlaylist | SoundCloudUser> {
    return this.http.request("/resolve", { query: { url } });
  }

  private pagination(options: PaginationOptions): {
    cursor?: string;
    maxItems?: number;
    pageSize?: number;
  } {
    return {
      ...(options.cursor ? { cursor: options.cursor } : {}),
      ...(options.maxItems !== undefined ? { maxItems: options.maxItems } : {}),
      ...(options.limit !== undefined ? { pageSize: options.limit } : {}),
    };
  }

  private uploadFields(metadata: UploadMetadata): Record<string, string> {
    const tags = tagsToString(metadata.tags);
    const fields: Record<string, string> = {
      "track[title]": metadata.title,
    };
    const assign = (key: string, value: string | undefined): void => {
      if (value !== undefined && value.length > 0) fields[key] = value;
    };
    assign("track[artist]", metadata.artist);
    assign("track[description]", metadata.description);
    assign("track[genre]", metadata.genre);
    assign("track[tag_list]", tags);
    assign("track[label_name]", metadata.labelName);
    assign("track[release_date]", metadata.releaseDate);
    assign("track[isrc]", metadata.isrc);
    assign("track[permalink]", metadata.permalink);
    assign("track[purchase_url]", metadata.purchaseUrl);
    assign("track[purchase_title]", metadata.purchaseTitle);
    assign("track[sharing]", metadata.sharing);
    assign("track[license]", metadata.license);
    assign("track[embeddable_by]", metadata.embeddableBy);
    if (metadata.downloadable !== undefined) fields["track[downloadable]"] = String(metadata.downloadable);
    if (metadata.streamable !== undefined) fields["track[streamable]"] = String(metadata.streamable);
    if (metadata.commentable !== undefined) fields["track[commentable]"] = String(metadata.commentable);
    if (metadata.revealStats !== undefined) fields["track[reveal_stats]"] = String(metadata.revealStats);
    if (metadata.revealComments !== undefined) fields["track[reveal_comments]"] = String(metadata.revealComments);
    return fields;
  }
}

export { makeFilePart };
export type { FilePart };
