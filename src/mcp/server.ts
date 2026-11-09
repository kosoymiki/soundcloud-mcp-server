/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../tools/context.js";
import { registerProfileTools } from "../tools/profile.js";
import { registerTrackTools } from "../tools/tracks.js";
import { registerPlaylistTools } from "../tools/playlists.js";
import { registerSocialTools } from "../tools/social.js";
import { registerAudioTools } from "../tools/audio.js";
import { registerWebTools } from "../tools/web.js";

export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer({
    name: "soundcloud-mcp-server",
    version: ctx.config.version,
  });

  registerProfileTools(server, ctx);
  registerTrackTools(server, ctx);
  registerPlaylistTools(server, ctx);
  registerSocialTools(server, ctx);
  registerAudioTools(server, ctx);
  registerWebTools(server, ctx);

  return server;
}
