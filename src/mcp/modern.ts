/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Modern-era MCP endpoint (2026-07-28) backed by FastMCP.
 * The legacy endpoint stays on @modelcontextprotocol/sdk (2025-11-25).
 *
 * Tools are registered per SoundCloud connection: the same tool modules are
 * run against a collector adapter, so handlers keep their connection-bound
 * ToolContext.
 */

import { FastMCP } from "@prefecthq/fastmcp-ts/server";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../tools/context.js";
import { registerAllTools } from "../tools/index.js";
import type { ToolRecord } from "../tools/registry.js";

type Collector = { records: ToolRecord[] };

function collectTools(ctx: ToolContext): ToolRecord[] {
  const collector: Collector = { records: [] };
  const adapter = {
    registerTool: () => undefined,
    __toolSink: {
      record: (name: string, definition: ToolRecord["definition"], handler: ToolRecord["handler"]) => {
        collector.records.push({ name, definition, handler });
      },
    },
  } as unknown as McpServer;
  registerAllTools(adapter, ctx);
  return collector.records;
}

export function createModernServer(ctx: ToolContext): FastMCP {
  const modern = new FastMCP({ name: "soundcloud-mcp-server", version: "2.0.0" });
  for (const tool of collectTools(ctx)) {
    modern.tool(
      {
        name: tool.name,
        description: tool.definition.description,
        input: z.object(tool.definition.schema),
        ...(tool.definition.annotations ? { annotations: tool.definition.annotations as never } : {}),
      },
      async (args) =>
        tool.handler(args as Record<string, unknown>, {
          signal: new AbortController().signal,
          _meta: {},
        })
    );
  }
  return modern;
}

const cache = new Map<string, FastMCP>();

export function modernServerFor(ctx: ToolContext): FastMCP {
  const existing = cache.get(ctx.connectionId);
  if (existing) return existing;
  const server = createModernServer(ctx);
  cache.set(ctx.connectionId, server);
  if (cache.size > 10) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  return server;
}

/** In-process Fetch entrypoint; FastMCP negotiates 2025 legacy or 2026-07-28 modern per request. */
export async function handleModernRequest(request: Request, ctx: ToolContext): Promise<Response> {
  return modernServerFor(ctx).fetch(request);
}
