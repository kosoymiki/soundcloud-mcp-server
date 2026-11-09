/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export interface SoundCloudUser {
  kind: "user";
  id: number;
  urn?: string;
  username: string;
  permalink?: string;
  permalink_url?: string;
  avatar_url?: string | null;
  description?: string;
  city?: string;
  country?: string;
  first_name?: string;
  last_name?: string;
  full_name?: string;
  website?: string;
  website_title?: string;
  track_count?: number;
  playlist_count?: number;
  followers_count?: number;
  followings_count?: number;
  likes_count?: number;
  reposts_count?: number;
  public_favorites_count?: number;
  plan?: string;
  created_at?: string;
  last_modified?: string;
  [key: string]: unknown;
}

export interface SoundCloudMe extends SoundCloudUser {
  quota?: {
    unlimited_upload_quota?: boolean;
    upload_seconds_used?: number;
    upload_seconds_left?: number | null;
  };
  upload_seconds_left?: number | null;
  private_tracks_count?: number;
  private_playlists_count?: number;
  primary_email_confirmed?: boolean;
  locale?: string | null;
}

export interface SoundCloudTrack {
  kind: "track";
  id: number;
  urn?: string;
  title: string;
  description?: string | null;
  duration?: number;
  genre?: string | null;
  tag_list?: string;
  permalink?: string;
  permalink_url?: string;
  artwork_url?: string | null;
  waveform_url?: string;
  streamable?: boolean;
  downloadable?: boolean;
  access?: "playable" | "preview" | "blocked" | string;
  sharing?: "public" | "private" | string;
  license?: string;
  label_name?: string | null;
  release_date?: string | null;
  isrc?: string | null;
  bpm?: number | null;
  playback_count?: number;
  download_count?: number;
  favoritings_count?: number;
  likes_count?: number;
  reposts_count?: number;
  comment_count?: number;
  created_at?: string;
  user?: SoundCloudUser;
  [key: string]: unknown;
}

export interface SoundCloudPlaylist {
  kind: "playlist";
  id: number;
  urn?: string;
  title: string;
  description?: string | null;
  sharing?: "public" | "private" | string;
  is_public?: boolean;
  track_count?: number;
  duration?: number;
  genre?: string | null;
  tag_list?: string;
  permalink?: string;
  permalink_url?: string;
  artwork_url?: string | null;
  release_date?: string | null;
  label_name?: string | null;
  set_type?: string;
  user?: SoundCloudUser;
  tracks?: Array<SoundCloudTrack | { id: number; urn?: string } | number>;
  [key: string]: unknown;
}

export interface SoundCloudComment {
  kind: "comment";
  id: number;
  body?: string;
  timestamp?: number | null;
  created_at?: string;
  user?: SoundCloudUser;
  [key: string]: unknown;
}

export interface StreamUrls {
  hls_aac_160_url?: string;
  hls_mp3_128_url?: string;
  preview_mp3_128_url?: string;
  http_mp3_128_url?: string;
  https_mp3_128_url?: string;
  [key: string]: unknown;
}

export interface Paged<T> {
  items: T[];
  next: string | null;
}

export type Scalar = string | number | boolean;

export type QueryParams = Record<string, Scalar | Scalar[] | null | undefined>;
