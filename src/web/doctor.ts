/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * One-call health check for the SoundCloud web-session runtime:
 * cookie file -> token lifetime -> Chromium -> live account + action discovery.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebActionSession } from "./actions.js";
import { defaultCookieFile, inspectCookieFile, jwtClaims, pickOAuthToken } from "./cookies.js";

export interface DoctorOptions {
  cookieFile?: string;
  chromePath?: string;
  /** Actually open the upload page, read /me and discover the live actions. */
  probe?: boolean;
  logger?: (level: "debug" | "info" | "warn", message: string) => void;
}

export interface DoctorStatus {
  ok: boolean;
  errors: string[];
  warnings: string[];
  cookie_file: {
    path: string;
    exists: boolean;
    mode: string | null;
    age_seconds: number | null;
    cookies: number;
    missing_required: string[];
    exported_at: string | null;
  };
  token: {
    present: boolean;
    expires_at: string | null;
    expires_in_seconds: number | null;
    expired: boolean;
    scope: string | null;
    client_id: string | null;
  };
  chrome: { path: string; exists: boolean };
  session?: {
    live: boolean;
    username?: string;
    user_id?: number;
    actions?: number;
    error?: string;
  };
}


function resolveChromePath(explicit?: string): string {
  return explicit ?? process.env.SC_WEB_CHROME ?? "chromium-browser";
}

export async function webSessionStatus(options: DoctorOptions = {}): Promise<DoctorStatus> {
  const cookieFile = options.cookieFile ?? defaultCookieFile();
  const chromePath = resolveChromePath(options.chromePath);
  const file = inspectCookieFile(cookieFile);
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!file.exists) errors.push(`no cookie file at ${cookieFile}; run the cookies command`);
  if (file.malformed) errors.push("cookie file is not valid JSON; re-export it with the cookies command");
  if (file.mode && file.mode !== "600") warnings.push(`cookie file mode is ${file.mode}; expected 600`);
  if (file.missingRequired.length > 0) errors.push(`missing cookies: ${file.missingRequired.join(", ")}`);
  if (file.expiresInSeconds !== null && file.expiresInSeconds <= 0) errors.push("oauth_token is expired; re-export cookies");
  else if (file.expiresInSeconds !== null && file.expiresInSeconds < 7200) {
    warnings.push(`oauth_token expires in ${Math.round(file.expiresInSeconds / 60)} min; re-export cookies soon`);
  }
  const chromeExists = existsSync(chromePath) || isOnPath(chromePath);
  if (!chromeExists) errors.push(`Chrome binary not found: ${chromePath} (set SC_WEB_CHROME)`);

  let claims: ReturnType<typeof jwtClaims> = null;
  if (file.exists) {
    try {
      const raw = JSON.parse(readFileSync(cookieFile, "utf8")) as {
        cookies?: { name?: string; value?: string }[];
      };
      const token = pickOAuthToken((raw.cookies ?? []).filter((cookie): cookie is { name: string; value: string } => Boolean(cookie.name && cookie.value)));
      if (token) claims = jwtClaims(token);
    } catch {
      warnings.push("cookie file is not valid JSON");
    }
  }

  const status: DoctorStatus = {
    ok: errors.length === 0,
    errors,
    warnings,
    cookie_file: {
      path: cookieFile,
      exists: file.exists,
      mode: file.mode,
      age_seconds: file.ageSeconds,
      cookies: file.cookies,
      missing_required: file.missingRequired,
      exported_at: file.exportedAt,
    },
    token: {
      present: claims !== null,
      expires_at: file.tokenExpiresAt,
      expires_in_seconds: file.expiresInSeconds,
      expired: file.expiresInSeconds !== null && file.expiresInSeconds <= 0,
      scope: claims?.scope ?? null,
      client_id: claims?.client_id ?? null,
    },
    chrome: { path: chromePath, exists: chromeExists },
  };

  if (options.probe && file.exists) {
    const session = new WebActionSession({
      cookieFile,
      chromePath,
      ...(options.logger ? { logger: options.logger } : {}),
    });
    try {
      await session.start();
      const me = await session.apiGet<{ id?: number; username?: string }>("/me");
      const discovered = await session.discoverActions();
      status.session = {
        live: true,
        ...(me?.username ? { username: me.username } : {}),
        ...(typeof me?.id === "number" ? { user_id: me.id } : {}),
        actions: discovered.actions.size,
      };
    } catch (error) {
      status.session = { live: false, error: error instanceof Error ? error.message : String(error) };
      status.ok = false;
    } finally {
      await session.close();
    }
  }

  return status;
}

function isOnPath(binary: string): boolean {
  if (binary.includes("/")) return false;
  const path = process.env.PATH ?? "";
  return path.split(":").some((dir) => dir && existsSync(join(dir, binary)));
}

function duration(seconds: number | null): string {
  if (seconds === null) return "unknown";
  const abs = Math.abs(seconds);
  const hours = Math.floor(abs / 3600);
  const minutes = Math.round((abs % 3600) / 60);
  const text = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  return seconds < 0 ? `${text} ago` : text;
}

/** Human-readable report; values of cookies are never included. */
export function formatDoctorStatus(status: DoctorStatus): string {
  const lines: string[] = [];
  const mark = (good: boolean): string => (good ? "ok  " : "FAIL");
  lines.push("SoundCloud web session");
  lines.push(
    `  ${mark(status.cookie_file.exists)}  cookies   ${status.cookie_file.path} (${status.cookie_file.cookies} cookies, ` +
      `mode ${status.cookie_file.mode ?? "?"}, age ${duration(status.cookie_file.age_seconds)})`
  );
  const tokenState = status.token.present
    ? status.token.expired
      ? `expired ${duration(status.token.expires_in_seconds)}`
      : `valid ${duration(status.token.expires_in_seconds)}`
    : "missing";
  lines.push(`  ${mark(status.token.present && !status.token.expired)}  token     ${tokenState}${status.token.scope ? `, scope ${status.token.scope}` : ""}`);
  lines.push(`  ${mark(status.chrome.exists)}  chromium  ${status.chrome.path}`);
  if (status.session) {
    lines.push(
      `  ${mark(status.session.live)}  session   ${
        status.session.live
          ? `live as ${status.session.username ?? "?"} (id ${status.session.user_id ?? "?"}), ${status.session.actions ?? 0} live actions`
          : `not live: ${status.session.error ?? "unknown error"}`
      }`
    );
  } else {
    lines.push("  --   session   not probed (pass --probe to open the upload page)");
  }
  if (status.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of status.warnings) lines.push(`  - ${warning}`);
  }
  if (status.errors.length > 0) {
    lines.push("Errors:");
    for (const error of status.errors) lines.push(`  - ${error}`);
  }
  return lines.join("\n");
}
