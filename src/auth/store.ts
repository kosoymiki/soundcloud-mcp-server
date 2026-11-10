/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { hashToken, open as openSealed, randomToken, seal } from "./crypto.js";
import { TtlMap } from "../util/ttl.js";

export interface Connection {
  id: string;
  label: string;
  scAccessToken: string;
  scRefreshToken?: string;
  scClientId?: string;
  scClientSecret?: string;
  /** Epoch ms. */
  scExpiresAt: number;
  scopes?: string;
  needsReauth?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface McpTokenRecord {
  /** sha256(token) hex. The raw token is only returned to the client. */
  hash: string;
  connectionId: string;
  clientId: string;
  kind: "access" | "refresh";
  expiresAt: number;
  createdAt: number;
}

export interface RegisteredClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: number;
}

export interface AuthCodeRecord {
  connectionId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  expiresAt: number;
}

export interface LoginState {
  kind: "mcp" | "panel";
  clientId?: string;
  redirectUri?: string;
  clientState?: string;
  codeChallenge?: string;
  scClientId: string;
  scClientSecret: string;
  codeVerifier: string;
  resource?: string;
  expiresAt: number;
}

interface PersistedState {
  version: 1;
  connections: Connection[];
  tokens: McpTokenRecord[];
  appCredentials?: {
    clientId: string;
    clientSecret: string;
    updatedAt: number;
  };
}

const STATE_VERSION = 1;

function emptyState(): PersistedState {
  return { version: STATE_VERSION, connections: [], tokens: [] };
}

export class Store {
  private state: PersistedState = emptyState();
  private readonly statePath: string;
  private readonly authCodes = new TtlMap<string, AuthCodeRecord>();
  private readonly loginStates = new TtlMap<string, LoginState>();
  private readonly clients = new TtlMap<string, RegisteredClient>();

  constructor(
    private readonly config: Config,
    private readonly logger: Logger
  ) {
    this.statePath = join(config.dataDir, "state.enc");
    this.load();
    this.pruneTokens();
  }

  dispose(): void {
    this.authCodes.dispose();
    this.loginStates.dispose();
    this.clients.dispose();
  }

  // ── Connections ────────────────────────────────────────────────────────────

  getConnection(id: string): Connection | undefined {
    return this.state.connections.find((connection) => connection.id === id);
  }

  requireConnection(id: string): Connection {
    const connection = this.getConnection(id);
    if (!connection) throw new Error(`Connection ${id} not found`);
    return connection;
  }

  listConnections(): Connection[] {
    return [...this.state.connections];
  }

  upsertConnection(connection: Connection): void {
    const index = this.state.connections.findIndex((item) => item.id === connection.id);
    if (index === -1) this.state.connections.push(connection);
    else this.state.connections[index] = connection;
    this.persist();
  }

  deleteConnection(id: string): void {
    this.state.connections = this.state.connections.filter((connection) => connection.id !== id);
    this.state.tokens = this.state.tokens.filter((token) => token.connectionId !== id);
    this.persist();
  }

  ensureLocalConnection(input: {    accessToken: string;
    refreshToken?: string;
    clientId?: string;
    clientSecret?: string;
    expiresIn?: number;
  }): Connection {
    const existing = this.getConnection("local");
    const now = Date.now();
    const refreshToken = input.refreshToken ?? existing?.scRefreshToken;
    const clientId = input.clientId ?? existing?.scClientId;
    const clientSecret = input.clientSecret ?? existing?.scClientSecret;
    const connection: Connection = {
      id: "local",
      label: "local",
      scAccessToken: input.accessToken,
      ...(refreshToken ? { scRefreshToken: refreshToken } : {}),
      ...(clientId ? { scClientId: clientId } : {}),
      ...(clientSecret ? { scClientSecret: clientSecret } : {}),
      scExpiresAt: now + Math.max(30, input.expiresIn ?? 3600) * 1000,
      ...(existing?.scopes ? { scopes: existing.scopes } : {}),
      needsReauth: false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.upsertConnection(connection);
    return connection;
  }

  // ── App credentials (encrypted at rest) ───────────────────────────────────

  getAppCredentials(): { clientId: string; clientSecret: string } | null {
    const stored = this.state.appCredentials;
    if (!stored) return null;
    return { clientId: stored.clientId, clientSecret: stored.clientSecret };
  }

  setAppCredentials(credentials: { clientId: string; clientSecret: string }): void {
    this.state.appCredentials = {
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      updatedAt: Date.now(),
    };
    this.persist();
  }

  // ── MCP tokens ────────────────────────────────────────────────────────────

  issueAccessToken(connectionId: string, clientId: string): { token: string; expiresAt: number } {
    return this.issueToken(connectionId, clientId, "access", this.config.security.accessTokenTtlMs);
  }

  issueRefreshToken(connectionId: string, clientId: string): { token: string; expiresAt: number } {
    return this.issueToken(connectionId, clientId, "refresh", this.config.security.refreshTokenTtlMs);
  }

  verifyAccessToken(token: string): McpTokenRecord | null {
    return this.verifyToken(token, "access");
  }

  verifyRefreshToken(token: string): McpTokenRecord | null {
    return this.verifyToken(token, "refresh");
  }

  revokeToken(token: string): void {
    const hash = hashToken(token);
    const before = this.state.tokens.length;
    this.state.tokens = this.state.tokens.filter((record) => record.hash !== hash);
    if (this.state.tokens.length !== before) this.persist();
  }

  revokeConnectionTokens(connectionId: string): void {
    const before = this.state.tokens.length;
    this.state.tokens = this.state.tokens.filter((record) => record.connectionId !== connectionId);
    if (this.state.tokens.length !== before) this.persist();
  }

  rotateRefreshToken(oldToken: string, clientId: string): { access: string; refresh: string; expiresAt: number } | null {
    const record = this.verifyRefreshToken(oldToken);
    if (!record) return null;
    if (record.clientId !== clientId) return null;
    this.revokeToken(oldToken);
    const access = this.issueAccessToken(record.connectionId, clientId);
    const refresh = this.issueRefreshToken(record.connectionId, clientId);
    return { access: access.token, refresh: refresh.token, expiresAt: access.expiresAt };
  }

  // ── Dynamic client registration ────────────────────────────────────────────

  registerClient(client: Omit<RegisteredClient, "createdAt">): RegisteredClient {
    // Bound dynamic client registration: TTL alone would let an attacker grow
    // the map for 30 days.
    if (this.clients.size >= 1000) {
      let oldest: RegisteredClient | null = null;
      for (const [, entry] of this.clients.entries()) {
        if (!oldest || entry.createdAt < oldest.createdAt) oldest = entry;
      }
      if (oldest) this.clients.delete(oldest.clientId);
    }
    const record: RegisteredClient = { ...client, createdAt: Date.now() };
    this.clients.set(record.clientId, record, 30 * 24 * 3600 * 1000);
    return record;
  }

  getClient(clientId: string): RegisteredClient | undefined {
    return this.clients.get(clientId);
  }

  // ── Authorization codes / login states ────────────────────────────────────

  storeAuthCode(record: AuthCodeRecord): string {
    const code = randomToken(32, "scmcp_code_");
    this.authCodes.set(hashToken(code), record, Math.max(30_000, record.expiresAt - Date.now()));
    return code;
  }

  consumeAuthCode(code: string): AuthCodeRecord | null {
    const hash = hashToken(code);
    const record = this.authCodes.get(hash);
    if (!record) return null;
    this.authCodes.delete(hash);
    if (record.expiresAt <= Date.now()) return null;
    return record;
  }

  storeLoginState(stateKey: string, state: Omit<LoginState, "expiresAt">): void {
    this.loginStates.set(stateKey, { ...state, expiresAt: Date.now() + 10 * 60_000 }, 10 * 60_000);
  }

  takeLoginState(stateKey: string): LoginState | null {
    const record = this.loginStates.get(stateKey);
    if (!record) return null;
    this.loginStates.delete(stateKey);
    return record;
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  private issueToken(
    connectionId: string,
    clientId: string,
    kind: "access" | "refresh",
    ttlMs: number
  ): { token: string; expiresAt: number } {
    // Long-running servers issue a token per login/refresh; keep the array bounded.
    if (this.state.tokens.length > 500) this.pruneTokens();
    const token = randomToken(32, kind === "access" ? "scmcp_at_" : "scmcp_rt_");
    const record: McpTokenRecord = {
      hash: hashToken(token),
      connectionId,
      clientId,
      kind,
      expiresAt: Date.now() + ttlMs,
      createdAt: Date.now(),
    };
    this.state.tokens.push(record);
    this.persist();
    return { token, expiresAt: record.expiresAt };
  }

  private verifyToken(token: string, kind: "access" | "refresh"): McpTokenRecord | null {
    const hash = hashToken(token);
    const record = this.state.tokens.find((entry) => entry.hash === hash);
    if (!record) return null;
    if (record.kind !== kind) return null;
    if (record.expiresAt <= Date.now()) {
      this.state.tokens = this.state.tokens.filter((entry) => entry.hash !== hash);
      this.persist();
      return null;
    }
    if (!this.getConnection(record.connectionId)) return null;
    return record;
  }

  private pruneTokens(): void {
    const now = Date.now();
    const before = this.state.tokens.length;
    this.state.tokens = this.state.tokens.filter((record) => record.expiresAt > now);
    if (this.state.tokens.length !== before) this.persist();
  }

  private load(): void {
    if (!existsSync(this.statePath)) return;
    try {
      const sealed = readFileSync(this.statePath, "utf8").trim();
      if (sealed.length === 0) return;
      const parsed = JSON.parse(openSealed(sealed, this.config.security.encryptionKey)) as PersistedState;
      if (parsed.version !== STATE_VERSION || !Array.isArray(parsed.connections) || !Array.isArray(parsed.tokens)) {
        throw new Error("state.enc has an unsupported shape");
      }
      this.state = parsed;
    } catch (error) {
      // Never destroy a state file we failed to read: keep it for recovery.
      let preserved: string | null = null;
      try {
        preserved = `${this.statePath}.corrupt-${Date.now()}`;
        renameSync(this.statePath, preserved);
      } catch {
        preserved = null;
      }
      this.logger.error("Failed to load encrypted state; starting empty", {
        error: error instanceof Error ? error.message : String(error),
        path: this.statePath,
        preserved,
      });
    }
  }

  private persist(): void {
    const sealed = seal(JSON.stringify(this.state), this.config.security.encryptionKey);
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${sealed}\n`, { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // Best effort.
    }
    renameSync(tmp, this.statePath);
  }
}
