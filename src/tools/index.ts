/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { registerProfileTools } from "./profile.js";
import { registerTrackTools } from "./tracks.js";
import { registerPlaylistTools } from "./playlists.js";
import { registerSocialTools } from "./social.js";
import { registerAudioTools } from "./audio.js";
import { registerWebTools } from "./web.js";

/** Register every MCP tool on the given server (legacy SDK or a collector adapter). */
export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  registerProfileTools(server, ctx);
  registerTrackTools(server, ctx);
  registerPlaylistTools(server, ctx);
  registerSocialTools(server, ctx);
  registerAudioTools(server, ctx);
  registerWebTools(server, ctx);
}
