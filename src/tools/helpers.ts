/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodRawShape } from "zod";
import { errorToMcp } from "../errors.js";

export interface ToolExtra {
  signal: AbortSignal;
  _meta?: { progressToken?: string | number; [key: string]: unknown };
  sendNotification?: (notification: unknown) => Promise<void>;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition {
  title: string;
  description: string;
  schema: ZodRawShape;
  annotations?: ToolAnnotations;
}

type Handler = (args: Record<string, unknown>, extra: ToolExtra) => Promise<unknown>;

export function jsonTool(server: McpServer, name: string, definition: ToolDefinition, handler: Handler): void {
  server.registerTool(
    name,
    {
      title: definition.title,
      description: definition.description,
      inputSchema: definition.schema,
      ...(definition.annotations ? { annotations: definition.annotations } : {}),
    },
    (async (args: Record<string, unknown>, extra: ToolExtra) => {
      try {
        const data = await handler(args, extra);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      } catch (error) {
        return errorToMcp(error);
      }
    }) as never
  );
}

/** Throttled MCP progress notifications driven by upload byte counts. */
export function progressReporter(extra: ToolExtra, totalBytes: number): (sentBytes: number) => void {
  const token = extra._meta?.progressToken;
  if (token === undefined || totalBytes <= 0) return () => undefined;
  let last = 0;
  return (sentBytes: number): void => {
    const now = Date.now();
    if (now - last < 750 && sentBytes < totalBytes) return;
    last = now;
    const percent = Math.min(100, Math.round((sentBytes / totalBytes) * 100));
    void extra
      .sendNotification?.({
        method: "notifications/progress",
        params: {
          progressToken: token,
          progress: sentBytes,
          total: totalBytes,
          message: `Uploading ${percent}%`,
        },
      })
      .catch(() => undefined);
  };
}

/** Accepts a numeric id, a soundcloud URN, or an api.soundcloud.com URL. */
export const idSchema = (label: string) =>
  z.union([z.string().min(1), z.number().int().nonnegative()]).describe(label);

export function stringOrStringArray(label: string) {
  return z.union([z.string(), z.array(z.string())]).describe(label);
}
