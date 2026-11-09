/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { Config } from "../config.js";

/**
 * Panel session cookie. The value is an MCP access token issued by this server
 * after a browser OAuth flow; it is never a SoundCloud token and never leaves
 * the server except as this HttpOnly cookie.
 */
export function panelCookie(config: Config, value: string, maxAgeSeconds: number, requestSecure = false): string {
  const secure = requestSecure || config.publicUrl.startsWith("https://") ? "; Secure" : "";
  return `scmcp_panel=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

export function clearPanelCookie(): string {
  return "scmcp_panel=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
}
