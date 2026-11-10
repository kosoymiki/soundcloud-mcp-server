/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Fresh SoundCloud cookies straight from a local Chrome/Chromium profile.
 *
 * Chrome on Android stores cookie values AES-128-CBC encrypted with a key
 * derived from the fixed "peanuts" password (OSCrypt Linux fallback); the
 * plaintext is prefixed with SHA-256(host_key) when the DB meta version is
 * above 23. Reading the profile usually needs root on Android, so the database
 * is staged into a private temp directory with `su` when the direct read is
 * denied. Cookie values are never logged.
 */

import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AppError } from "../errors.js";

export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  expirationDate?: number;
}

export interface CookieExport {
  exported_at: string;
  source: string;
  cookies: BrowserCookie[];
}

export interface CookieExportResult {
  outPath: string;
  cookies: number;
  names: string[];
  exportedAt: string;
  tokenExpiresAt: string | null;
  expiresInSeconds: number | null;
  missingRequired: string[];
  source: string;
}

export interface JwtClaims {
  exp?: number;
  iat?: number;
  scope?: string;
  client_id?: string;
}

/** Cookie names the web uploader cannot work without. */
export const REQUIRED_COOKIES = ["oauth_token", "oauth_refresh_token", "sc_session", "datadome"] as const;

const CHROME_PASSWORD = "peanuts";
const CHROME_SALT = "saltysalt";
const CHROME_ITERATIONS = 1;
const CHROME_KEY_LENGTH = 16;
const CHROME_IV = Buffer.alloc(16, 0x20);
/** Seconds between the Windows/Chrome epoch (1601-01-01) and the Unix epoch. */
const CHROME_EPOCH_OFFSET = 11_644_473_600;

/** OSCrypt key: PBKDF2-HMAC-SHA1("peanuts", "saltysalt", 1 iteration). */
export function chromeCookieKey(password = CHROME_PASSWORD): Buffer {
  return pbkdf2Sync(password, CHROME_SALT, CHROME_ITERATIONS, CHROME_KEY_LENGTH, "sha1");
}

function looksPrintable(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  let printable = 0;
  for (const byte of buffer) {
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte <= 0x7e)) printable += 1;
  }
  return printable / buffer.length > 0.9;
}

/**
 * Decrypt one Chrome `encrypted_value` blob (`v10`/`v11` prefix).
 * Throws for app-bound `v20` values, which cannot be decrypted outside Chrome.
 */
export function decryptChromeValue(encrypted: Buffer, key: Buffer, hostKey: string): string {
  if (encrypted.length === 0) return "";
  const prefix = encrypted.subarray(0, 3).toString("latin1");
  if (prefix === "v20") {
    throw new AppError("INTERNAL", "This cookie uses Chrome's app-bound encryption (v20) and cannot be read outside the browser.", {
      status: 500,
      details: { hostKey },
    });
  }
  if (prefix !== "v10" && prefix !== "v11") return encrypted.toString("utf8");
  const decipher = createDecipheriv("aes-128-cbc", key, CHROME_IV);
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
  } catch (error) {
    throw new AppError("INTERNAL", "Chrome cookie decryption failed: unsupported OSCrypt key or profile format.", {
      status: 500,
      details: { hostKey, error: error instanceof Error ? error.message : String(error) },
    });
  }
  // Chromium DB meta version >= 24 binds the value to its host: SHA-256(host_key) + value.
  const hostHash = createHash("sha256").update(hostKey).digest();
  if (plain.length >= 32 && plain.subarray(0, 32).equals(hostHash)) return plain.subarray(32).toString("utf8");
  if (plain.length > 32 && !looksPrintable(plain.subarray(0, 32)) && looksPrintable(plain.subarray(32, Math.min(64, plain.length)))) {
    return plain.subarray(32).toString("utf8");
  }
  return plain.toString("utf8");
}

/** Pick the longest-lived `oauth_token` (Chrome stores one per SoundCloud host). */
export function pickOAuthToken(cookies: { name: string; value: string }[]): string | null {
  let best: { value: string; exp: number } | null = null;
  for (const cookie of cookies) {
    if (cookie.name !== "oauth_token" || !cookie.value) continue;
    const exp = jwtClaims(cookie.value)?.exp ?? 0;
    if (!best || exp > best.exp) best = { value: cookie.value, exp };
  }
  return best?.value ?? null;
}

/** Read JWT claims from a SoundCloud `oauth_token` cookie value. */
export function jwtClaims(token: string): JwtClaims | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
    return {
      ...(typeof payload.exp === "number" ? { exp: payload.exp } : {}),
      ...(typeof payload.iat === "number" ? { iat: payload.iat } : {}),
      ...(typeof payload.scope === "string" ? { scope: payload.scope } : {}),
      ...(typeof payload.client_id === "string" ? { client_id: payload.client_id } : {}),
    };
  } catch {
    return null;
  }
}

/** Chrome stores expiry as microseconds since 1601-01-01. */
export function chromeExpiryToUnix(expiresUtc: number | bigint | null): number | undefined {
  if (expiresUtc === null) return undefined;
  const micros = typeof expiresUtc === "bigint" ? Number(expiresUtc) : expiresUtc;
  if (!Number.isFinite(micros) || micros <= 0) return undefined;
  return Math.round(micros / 1_000_000 - CHROME_EPOCH_OFFSET);
}

function sameSiteName(value: number | bigint | null): BrowserCookie["sameSite"] {
  const numeric = typeof value === "bigint" ? Number(value) : value;
  if (numeric === 0) return "None";
  if (numeric === 1) return "Lax";
  if (numeric === 2) return "Strict";
  return undefined;
}

export function isAndroidHost(): boolean {
  return /android/i.test(release());
}

/** Nearest ancestor containing `.git`, or null. */
export function findGitWorkTree(path: string): string | null {
  let dir = dirname(resolve(path));
  for (let depth = 0; depth < 40; depth += 1) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Cookie exports must never land inside a repository that could be committed/pushed. */
function assertOutsideRepository(outPath: string): void {
  if (process.env.SC_ALLOW_COOKIES_IN_REPO === "1") return;
  const root = findGitWorkTree(outPath);
  if (root) {
    throw new AppError(
      "BAD_REQUEST",
      `Refusing to write cookies inside the git repository at ${root}. Use DATA_DIR (default ~/.local/share/soundcloud-mcp) or set SC_ALLOW_COOKIES_IN_REPO=1.`,
      { status: 400, details: { outPath, repository: root } }
    );
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function readable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function existsForCurrentUser(path: string): boolean {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Check existence of root-only paths without failing when `su` is unavailable. */
function existsWithRoot(path: string): boolean {
  if (!isAndroidHost()) return false;
  try {
    execFileSync("su", ["-c", `test -f ${shellQuote(path)}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Common Chrome/Chromium profile locations, in priority order. */
export function chromeCookieCandidates(): string[] {
  return [
    process.env.CHROME_COOKIES_DB ?? "",
    join(homedir(), ".config", "chromium", "Default", "Cookies"),
    join(homedir(), ".config", "google-chrome", "Default", "Cookies"),
    join(homedir(), ".config", "chromium-headless", "Default", "Cookies"),
    "/data/data/com.android.chrome/app_chrome/Default/Cookies",
    "/data/data/com.brave.browser/app_chrome/Default/Cookies",
    "/data/data/com.microsoft.emmx/app_chrome/Default/Cookies",
  ].filter(Boolean);
}

export function findChromeCookiesDb(explicit?: string): string {
  const candidates = explicit ? [explicit, ...chromeCookieCandidates()] : chromeCookieCandidates();
  for (const candidate of candidates) {
    if (existsForCurrentUser(candidate) || existsWithRoot(candidate)) return candidate;
  }
  throw new AppError("NOT_FOUND", "No Chrome/Chromium cookie database found. Pass --db <Cookies path> or set CHROME_COOKIES_DB.", {
    status: 404,
    details: { searched: candidates },
  });
}

export interface StagedDatabase {
  path: string;
  cleanup: () => void;
  viaRoot: boolean;
}

/** Copy a (possibly root-only) cookie DB plus its WAL/SHM sidecars into a private temp dir. */
export function stageCookiesDatabase(sourcePath: string): StagedDatabase {
  const dir = mkdtempSync(join(tmpdir(), "sc-chrome-cookies-"));
  const target = join(dir, "Cookies");
  const cleanup = (): void => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  };
  const copySidecars = (): void => {
    for (const suffix of ["-wal", "-shm"]) {
      try {
        copyFileSync(`${sourcePath}${suffix}`, `${target}${suffix}`);
      } catch {
        // A missing sidecar just means the WAL was checkpointed.
      }
    }
  };
  if (readable(sourcePath)) {
    copyFileSync(sourcePath, target);
    copySidecars();
    return { path: target, cleanup, viaRoot: false };
  }
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (!isAndroidHost() || uid === undefined || gid === undefined) {
    throw new AppError("INTERNAL", `Cookie database ${sourcePath} is not readable.`, { status: 500 });
  }
  const command = [
    `cp ${shellQuote(sourcePath)} ${shellQuote(target)}`,
    `(cp ${shellQuote(`${sourcePath}-wal`)} ${shellQuote(`${target}-wal`)} 2>/dev/null || true)`,
    `(cp ${shellQuote(`${sourcePath}-shm`)} ${shellQuote(`${target}-shm`)} 2>/dev/null || true)`,
    `chown ${uid}:${gid} ${shellQuote(target)} ${shellQuote(`${target}-wal`)} ${shellQuote(`${target}-shm`)} 2>/dev/null || true`,
  ].join(" && ");
  try {
    execFileSync("su", ["-c", command], { stdio: "ignore" });
  } catch (error) {
    throw new AppError("INTERNAL", `Could not copy the cookie database with su: ${error instanceof Error ? error.message : String(error)}`, {
      status: 500,
    });
  }
  return { path: target, cleanup, viaRoot: true };}

interface CookieRow {
  host_key: string;
  name: string;
  value: string;
  encrypted_value: Uint8Array | null;
  path: string;
  expires_utc: number | bigint | null;
  is_secure: number | bigint | null;
  is_httponly: number | bigint | null;
  samesite: number | bigint | null;
}

/** Read and decrypt SoundCloud cookies from a staged Chrome cookie database. */
export function readChromeCookies(dbPath: string): BrowserCookie[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const statement = db.prepare(
      "select host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite " +
        "from cookies where host_key like '%soundcloud%' order by host_key, name"
    );
    // Chrome stores expiry in microseconds since 1601, which exceeds 2^53.
    statement.setReadBigInts(true);
    const rows = statement.all() as unknown as CookieRow[];
    const key = chromeCookieKey();
    const cookies: BrowserCookie[] = [];
    for (const row of rows) {
      const encrypted = row.encrypted_value ? Buffer.from(row.encrypted_value) : null;
      const value = encrypted ? decryptChromeValue(encrypted, key, row.host_key) : String(row.value ?? "");
      if (!value) continue;
      const expires = chromeExpiryToUnix(row.expires_utc);
      const sameSite = sameSiteName(row.samesite);
      cookies.push({
        name: row.name,
        value,
        domain: row.host_key,
        path: row.path || "/",
        secure: Number(row.is_secure ?? 0) === 1,
        httpOnly: Number(row.is_httponly ?? 0) === 1,
        ...(sameSite ? { sameSite } : {}),
        ...(expires ? { expirationDate: expires } : {}),
      });
    }
    return cookies;
  } finally {
    db.close();
  }
}

export interface ExportOptions {
  dbPath?: string;
  outPath?: string;
  /** Stage a copy even when the DB is readable (useful for live profiles). */
  forceCopy?: boolean;
}

/** Export SoundCloud cookies from Chrome into the 0600 JSON the uploader reads. */
export function exportSoundCloudCookies(options: ExportOptions = {}): CookieExportResult {
  const outPath = options.outPath ?? join(homedir(), ".local", "share", "soundcloud-mcp", "chrome-soundcloud-cookies.json");
  assertOutsideRepository(outPath);
  const dbPath = findChromeCookiesDb(options.dbPath);
  const staged = options.forceCopy || !readable(dbPath) ? stageCookiesDatabase(dbPath) : null;
  const readPath = staged?.path ?? dbPath;
  let cookies: BrowserCookie[];
  try {
    cookies = readChromeCookies(readPath);
  } finally {
    staged?.cleanup();
  }
  if (cookies.length === 0) {
    throw new AppError("UNAUTHORIZED", "The cookie database has no SoundCloud cookies; log in to SoundCloud in that browser first.", {
      status: 401,
    });
  }
  mkdirSync(dirname(outPath), { recursive: true, mode: 0o700 });
  const exportedAt = new Date().toISOString();
  const payload: CookieExport = { exported_at: exportedAt, source: "chrome-sqlite", cookies };
  writeFileSync(outPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
  try {
    chmodSync(outPath, 0o600);
  } catch {
    // Best effort on filesystems without POSIX modes.
  }
  const names = cookies.map((cookie) => cookie.name).sort();
  const token = pickOAuthToken(cookies);
  const claims = token ? jwtClaims(token) : null;
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    outPath,
    cookies: cookies.length,
    names,
    exportedAt,
    tokenExpiresAt: claims?.exp ? new Date(claims.exp * 1000).toISOString() : null,
    expiresInSeconds: claims?.exp ? claims.exp - nowSeconds : null,
    missingRequired: REQUIRED_COOKIES.filter((name) => !names.includes(name)),
    source: dbPath,
  };
}

export interface RefreshResult {
  outPath: string;
  refreshed: boolean;
  tokenExpiresAt: string | null;
  expiresInSeconds: number | null;
}

/**
 * Exchange the stored `oauth_refresh_token` for a new `oauth_token` and rewrite
 * the cookie file in place. SoundCloud's web client is a public client, so the
 * refresh needs only `client_id` (taken from the current JWT) and the refresh
 * token; no client secret exists for a browser session.
 */
export async function refreshSoundCloudCookies(
  options: { cookieFile?: string; tokenUrl?: string; clientId?: string } = {}
): Promise<RefreshResult> {
  const outPath = options.cookieFile ?? join(homedir(), ".local", "share", "soundcloud-mcp", "chrome-soundcloud-cookies.json");
  assertOutsideRepository(outPath);
  if (!existsSync(outPath)) {
    throw new AppError("UNAUTHORIZED", `No cookie file at ${outPath}; export cookies first.`, { status: 401 });
  }
  const raw = JSON.parse(readFileSync(outPath, "utf8")) as CookieExport;
  const cookies = raw.cookies ?? [];
  const token = pickOAuthToken(cookies) ?? "";
  const clientId = options.clientId ?? jwtClaims(token)?.client_id;
  const refreshToken =
    cookies.find((cookie) => cookie.name === "oauth_refresh_token" && cookie.domain === "soundcloud.com")?.value ??
    cookies.find((cookie) => cookie.name === "oauth_refresh_token")?.value;
  if (!clientId || !refreshToken) {
    throw new AppError("UNAUTHORIZED", "The cookie file has no refreshable session (needs oauth_refresh_token and a JWT client_id).", {
      status: 401,
    });
  }
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId });
  const response = await fetch(options.tokenUrl ?? process.env.SC_WEB_TOKEN_URL ?? "https://secure.soundcloud.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new AppError("NEEDS_REAUTH", `SoundCloud rejected the token refresh (HTTP ${response.status}); re-export cookies from the browser.`, {
      status: response.status,
      details: { body: text.slice(0, 200) },
    });
  }
  let payload: { access_token?: string; refresh_token?: string };
  try {
    payload = JSON.parse(text) as { access_token?: string; refresh_token?: string };
  } catch {
    throw new AppError("INVALID_RESPONSE", "SoundCloud token refresh returned non-JSON.", { status: 502 });
  }
  const accessToken = payload.access_token;
  if (!accessToken) throw new AppError("INVALID_RESPONSE", "SoundCloud token refresh returned no access_token.", { status: 502 });
  const claims = jwtClaims(accessToken);
  let updated = 0;
  for (const cookie of cookies) {
    if (cookie.name === "oauth_token") {
      cookie.value = accessToken;
      if (claims?.exp) cookie.expirationDate = claims.exp;
      updated += 1;
    } else if (cookie.name === "oauth_refresh_token" && payload.refresh_token) {
      cookie.value = payload.refresh_token;
    }
  }
  writeFileSync(
    outPath,
    JSON.stringify({ ...raw, exported_at: new Date().toISOString(), source: raw.source ?? "chrome-refresh", cookies }, null, 2),
    { mode: 0o600 }
  );
  try {
    chmodSync(outPath, 0o600);
  } catch {
    // Best effort.
  }
  return {
    outPath,
    refreshed: updated > 0,
    tokenExpiresAt: claims?.exp ? new Date(claims.exp * 1000).toISOString() : null,
    expiresInSeconds: claims?.exp ? claims.exp - Math.floor(Date.now() / 1000) : null,
  };
}

/** Inspect an existing cookie export without touching the browser. */
export function inspectCookieFile(path: string): {
  exists: boolean;
  mode: string | null;
  ageSeconds: number | null;
  cookies: number;
  missingRequired: string[];
  exportedAt: string | null;
  tokenExpiresAt: string | null;
  expiresInSeconds: number | null;
} {
  if (!existsSync(path)) {
    return { exists: false, mode: null, ageSeconds: null, cookies: 0, missingRequired: [...REQUIRED_COOKIES], exportedAt: null, tokenExpiresAt: null, expiresInSeconds: null };
  }
  const stats = statSync(path);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<CookieExport>;
  const cookies = Array.isArray(raw.cookies) ? raw.cookies : [];
  const names = cookies.map((cookie) => cookie.name);
  const token = pickOAuthToken(cookies);
  const claims = token ? jwtClaims(token) : null;
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    exists: true,
    mode: (stats.mode & 0o777).toString(8),
    ageSeconds: Math.max(0, Math.round((Date.now() - stats.mtimeMs) / 1000)),
    cookies: cookies.length,
    missingRequired: REQUIRED_COOKIES.filter((name) => !names.includes(name)),
    exportedAt: typeof raw.exported_at === "string" ? raw.exported_at : null,
    tokenExpiresAt: claims?.exp ? new Date(claims.exp * 1000).toISOString() : null,
    expiresInSeconds: claims?.exp ? claims.exp - nowSeconds : null,
  };
}
