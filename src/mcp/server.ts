/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../tools/context.js";
import { registerAllTools } from "../tools/index.js";
import { registerProjectResources } from "./resources.js";

export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer({
    name: "soundcloud-mcp-server",
    version: ctx.config.version,
  });

  registerAllTools(server, ctx);
  registerProjectResources(server);

  return server;
}
