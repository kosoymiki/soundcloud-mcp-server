/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Logger } from "../logger.js";
import { TtlMap } from "../util/ttl.js";

export interface McpSession {
  id: string;
  transport: StreamableHTTPServerTransport;
  connectionId: string;
  tokenHash: string;
  clientId: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface SessionManagerOptions {
  idleTtlMs: number;
  maxSessions: number;
  logger: Logger;
}

export class McpSessionManager {
  private readonly sessions = new TtlMap<string, McpSession>(60_000);
  private readonly createdAt = new Map<string, number>();

  constructor(private readonly options: SessionManagerOptions) {}

  create(session: Omit<McpSession, "createdAt" | "lastSeenAt">): McpSession {
    if (this.sessions.size >= this.options.maxSessions) {
      const oldest = this.oldestSession();
      if (oldest) this.delete(oldest.id);
    }
    const entry: McpSession = { ...session, createdAt: Date.now(), lastSeenAt: Date.now() };
    this.sessions.set(session.id, entry, this.options.idleTtlMs);
    this.createdAt.set(session.id, entry.createdAt);
    return entry;
  }

  get(id: string): McpSession | undefined {
    const entry = this.sessions.get(id);
    if (entry) {
      entry.lastSeenAt = Date.now();
      this.sessions.set(id, entry, this.options.idleTtlMs);
    }
    return entry;
  }

  /** Constant-time-ish binding check: a session only accepts its own token. */
  tokenMatches(session: McpSession, tokenHash: string): boolean {
    return session.tokenHash === tokenHash;
  }

  delete(id: string): void {
    const entry = this.sessions.get(id);
    this.sessions.delete(id);
    this.createdAt.delete(id);
    if (entry) {
      void entry.transport.close().catch(() => undefined);
    }
  }

  sweep(): void {
    const now = Date.now();
    for (const [id, entry] of this.sessions.entries()) {
      if (now - entry.lastSeenAt > this.options.idleTtlMs) {
        this.options.logger.debug("Closing idle MCP session", { session: id });
        this.delete(id);
      }
    }
  }

  closeAll(): void {
    for (const [id] of this.sessions.entries()) this.delete(id);
  }

  get size(): number {
    return this.sessions.size;
  }

  private oldestSession(): McpSession | null {
    let oldest: McpSession | null = null;
    for (const [, entry] of this.sessions.entries()) {
      if (!oldest || entry.createdAt < oldest.createdAt) oldest = entry;
    }
    return oldest;
  }
}
