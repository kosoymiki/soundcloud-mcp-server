/*
 * Copyright (C) 2026 Marcell Kehmstedt
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

export type McpMode = "local" | "oauth" | "both";

export interface SoundCloudConfig {
  apiBase: string;
  authBase: string;
  authorizeUrl: string;
  tokenUrl: string;
  redirectUri: string;
  clientId?: string;
  clientSecret?: string;
  authScheme: "OAuth" | "Bearer";
  timeoutMs: number;
  maxRetries: number;
  maxUploadBytes: number;
}

export interface SecurityConfig {
  encryptionKey: Buffer;
  localToken: string;
  accessTokenTtlMs: number;
  refreshTokenTtlMs: number;
  sessionIdleTtlMs: number;
  panelAutoLogin: boolean;
}

export interface AudioConfig {
  ffmpegPath: string;
  ffprobePath: string;
  workDir: string;
  maxConcurrent: number;
}

export interface Config {
  version: string;
  port: number;
  host: string;
  publicUrl: string;
  dataDir: string;
  mediaRoots: string[];
  mode: McpMode;
  sc: SoundCloudConfig;
  security: SecurityConfig;
  audio: AudioConfig;
  brandColor: string;
  debug: boolean;
  logLevel: "debug" | "info" | "warn" | "error";
  jsonResponse: boolean;
  autoOpenBrowser: boolean;
  startedAt: number;
}

const DEFAULT_DATA_DIR = join(homedir(), ".local", "share", "soundcloud-mcp");
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function env(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  return input;
}

function absolute(input: string): string {
  const expanded = expandHome(input);
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
}

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Best effort: some Android/Termux setups ignore chmod on shared storage.
  }
}

function readOrCreateSecret(path: string, bytes: number): string {
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length > 0) return existing;
  }
  const generated = randomBytes(bytes).toString("base64url");
  writeFileSync(path, `${generated}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort.
  }
  return generated;
}

function parseEncryptionKey(raw: string | undefined, dataDir: string): Buffer {
  if (raw) {
    const buffer = Buffer.from(raw, "base64");
    if (buffer.length !== 32) {
      throw new Error("MCP_ENCRYPTION_KEY must be 32 bytes encoded as base64.");
    }
    return buffer;
  }
  const secretPath = join(dataDir, "encryption.key");
  const value = readOrCreateSecret(secretPath, 32);
  const buffer = Buffer.from(value, "base64");
  if (buffer.length !== 32) {
    throw new Error(`Invalid encryption key in ${secretPath}; delete the file to regenerate.`);
  }
  return buffer;
}

function parseMode(raw: string | undefined): McpMode {
  if (raw === undefined) return "both";
  if (raw === "local" || raw === "oauth" || raw === "both") return raw;
  throw new Error(`MCP_MODE must be local, oauth or both (received ${JSON.stringify(raw)}).`);
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}] (received ${JSON.stringify(raw)}).`);
  }
  return value;
}

function normalizeBaseUrl(raw: string): string {
  const value = raw.replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`PUBLIC_URL must be an absolute URL (received ${JSON.stringify(raw)}).`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("PUBLIC_URL must use http or https.");
  }
  return value;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const dataDir = absolute(env("DATA_DIR") ?? DEFAULT_DATA_DIR);
  ensurePrivateDir(dataDir);

  const publicUrl = normalizeBaseUrl(env("PUBLIC_URL") ?? `http://localhost:${env("PORT") ?? "3000"}`);
  const authBase = (env("SC_AUTH_BASE") ?? "https://secure.soundcloud.com").replace(/\/+$/, "");
  const apiBase = (env("SC_API_BASE") ?? "https://api.soundcloud.com").replace(/\/+$/, "");

  const mediaRootsRaw = env("SC_MEDIA_DIRS") ?? "~";
  const mediaRoots = mediaRootsRaw
    .split(":")
    .map((part) => part.trim())
    .filter(Boolean)
    .map(absolute);

  const audioWorkDir = absolute(env("AUDIO_WORK_DIR") ?? join(dataDir, "edits"));
  ensurePrivateDir(audioWorkDir);

  const authScheme = (env("SC_AUTH_SCHEME") ?? "OAuth").toLowerCase() === "bearer" ? "Bearer" : "OAuth";

  const localToken =
    env("MCP_LOCAL_TOKEN") ??
    readOrCreateSecret(join(dataDir, "local-token"), 32);

  const brandColorRaw = env("UI_BRAND_COLOR");
  const brandColor =
    brandColorRaw && HEX_COLOR.test(brandColorRaw) ? brandColorRaw.toLowerCase() : "#f50";

  const logLevelRaw = env("LOG_LEVEL");
  const logLevel =
    logLevelRaw === "debug" || logLevelRaw === "info" || logLevelRaw === "warn" || logLevelRaw === "error"
      ? logLevelRaw
      : "info";

  const config: Config = {
    version: "2.0.0",
    port: intEnv("PORT", 3000, 1, 65535),
    host: env("HOST") ?? "127.0.0.1",
    publicUrl,
    dataDir,
    mediaRoots,
    mode: parseMode(env("MCP_MODE")),
    sc: {
      apiBase,
      authBase,
      authorizeUrl: `${authBase}/authorize`,
      tokenUrl: `${authBase}/oauth/token`,
      redirectUri: env("SC_REDIRECT_URI") ?? `${publicUrl}/soundcloud/callback`,
      clientId: env("SC_CLIENT_ID"),
      clientSecret: env("SC_CLIENT_SECRET"),
      authScheme,
      timeoutMs: intEnv("SC_TIMEOUT_MS", 30_000, 1_000, 120_000),
      maxRetries: intEnv("SC_MAX_RETRIES", 2, 0, 5),
      maxUploadBytes: intEnv("SC_MAX_UPLOAD_BYTES", 4 * 1024 * 1024 * 1024, 1, 4 * 1024 * 1024 * 1024),
    },
    security: {
      encryptionKey: parseEncryptionKey(env("MCP_ENCRYPTION_KEY"), dataDir),
      localToken,
      accessTokenTtlMs: intEnv("MCP_ACCESS_TOKEN_TTL", 7 * 24 * 3600, 60, 365 * 24 * 3600) * 1000,
      refreshTokenTtlMs: intEnv("MCP_REFRESH_TOKEN_TTL", 30 * 24 * 3600, 60, 365 * 24 * 3600) * 1000,
      sessionIdleTtlMs: intEnv("MCP_SESSION_IDLE_TTL", 30 * 60, 30, 24 * 3600) * 1000,
      panelAutoLogin: (env("MCP_PANEL_AUTO_LOGIN") ?? "true") !== "false",
    },
    audio: {
      ffmpegPath: env("FFMPEG_PATH") ?? "ffmpeg",
      ffprobePath: env("FFPROBE_PATH") ?? "ffprobe",
      workDir: audioWorkDir,
      maxConcurrent: intEnv("AUDIO_MAX_CONCURRENT", 2, 1, 8),
    },
    brandColor,
    debug: (env("MCP_DEBUG") ?? "false") === "true" || (env("LOG_LEVEL") ?? "") === "debug",
    logLevel,
    jsonResponse: (env("MCP_JSON_RESPONSE") ?? "false") === "true",
    autoOpenBrowser: (env("MCP_OPEN_BROWSER") ?? "true") !== "false",
    startedAt: Date.now(),
    ...overrides,
  };

  return config;
}
