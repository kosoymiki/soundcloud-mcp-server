/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Registry of tool definitions so the same tools can be served by both the
 * legacy (2025-11-25) MCP endpoint and the modern (2026-07-28) FastMCP
 * endpoint, without duplicating registrations.
 */

import type { ZodRawShape } from "zod";

export interface ToolRecord {
  name: string;
  definition: {
    title?: string;
    description: string;
    schema: ZodRawShape;
    annotations?: Record<string, unknown>;
  };
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
}

const records: ToolRecord[] = [];

export function recordTool(record: ToolRecord): void {
  if (!records.some((existing) => existing.name === record.name)) records.push(record);
}

export function registeredTools(): readonly ToolRecord[] {
  return records;
}
