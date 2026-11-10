/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Logger } from "../logger.js";

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
  /**
   * Plain Map (not TtlMap): expiry must go through delete() so the transport is
   * closed. A self-expiring map would drop entries before the manager could
   * close them, leaking SSE connections and the server behind each session.
   */
  private readonly sessions = new Map<string, McpSession>();

  constructor(private readonly options: SessionManagerOptions) {}

  create(session: Omit<McpSession, "createdAt" | "lastSeenAt">): McpSession {
    if (this.sessions.size >= this.options.maxSessions) {
      const oldest = this.oldestSession();
      if (oldest) this.delete(oldest.id);
    }
    const entry: McpSession = { ...session, createdAt: Date.now(), lastSeenAt: Date.now() };
    this.sessions.set(session.id, entry);
    return entry;
  }

  get(id: string): McpSession | undefined {
    const entry = this.sessions.get(id);
    if (!entry) return undefined;
    if (Date.now() - entry.lastSeenAt > this.options.idleTtlMs) {
      this.delete(id);
      return undefined;
    }
    entry.lastSeenAt = Date.now();
    return entry;
  }

  /** Constant-time-ish binding check: a session only accepts its own token. */
  tokenMatches(session: McpSession, tokenHash: string): boolean {
    return session.tokenHash === tokenHash;
  }

  delete(id: string): void {
    const entry = this.sessions.get(id);
    if (!entry) return;
    this.sessions.delete(id);
    void entry.transport.close().catch(() => undefined);
  }

  sweep(): void {
    const now = Date.now();
    for (const [id, entry] of this.sessions) {
      if (now - entry.lastSeenAt > this.options.idleTtlMs) {
        this.options.logger.debug("Closing idle MCP session", { session: id });
        this.delete(id);
      }
    }
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.delete(id);
  }

  get size(): number {
    return this.sessions.size;
  }

  private oldestSession(): McpSession | null {
    let oldest: McpSession | null = null;
    for (const entry of this.sessions.values()) {
      if (!oldest || entry.createdAt < oldest.createdAt) oldest = entry;
    }
    return oldest;
  }
}
