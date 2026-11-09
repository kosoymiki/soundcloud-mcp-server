/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { Request } from "express";
import { timingSafeEqual } from "node:crypto";
import type { Config } from "../config.js";
import type { Store } from "../auth/store.js";
import { hashToken } from "../auth/crypto.js";
import { isLoopbackAddress } from "../auth/oauth.js";

/** Constant-time comparison for secrets of arbitrary length (compares SHA-256 digests). */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(hashToken(a), "hex");
  const right = Buffer.from(hashToken(b), "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface AuthResult {
  connectionId: string;
  tokenHash: string;
  clientId: string;
  kind: "local" | "local-token" | "oauth" | "panel-cookie";
}

export function extractBearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^(Bearer|OAuth)\s+(.+)$/i.exec(header.trim());
  return match?.[2]?.trim() ?? null;
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (typeof header !== "string") return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export class Authenticator {
  constructor(
    private readonly config: Config,
    private readonly store: Store
  ) {}

  /** Token supplied in Authorization header, panel cookie, or local loopback. */
  authenticate(req: Request): AuthResult | null {
    const bearer = extractBearer(req);
    if (bearer) {
      const result = this.authenticateToken(bearer);
      if (!result) return null;
      return {
        ...result,
        kind: result.kind === "local" ? "local-token" : result.kind,
      };
    }

    const cookieToken = readCookie(req, "scmcp_panel");
    if (cookieToken) {
      const result = this.authenticateToken(cookieToken);
      if (result) return { ...result, kind: "panel-cookie" };
    }

    if (this.isLocalMode() && this.config.security.panelAutoLogin && isLoopbackAddress(req.socket.remoteAddress)) {
      const local = this.store.getConnection("local");
      if (local) {
        return {
          connectionId: "local",
          tokenHash: hashToken(this.config.security.localToken),
          clientId: "local",
          kind: "local",
        };
      }
    }
    return null;
  }

  authenticateToken(token: string): AuthResult | null {
    if (this.isLocalMode() && this.config.security.localToken.length > 0) {
      const expected = this.config.security.localToken;
      if (token.length === expected.length && constantTimeEqual(token, expected)) {
        const connection = this.store.getConnection("local");
        if (connection) {
          return {
            connectionId: "local",
            tokenHash: hashToken(token),
            clientId: "local",
            kind: "local",
          };
        }
      }
    }
    const record = this.store.verifyAccessToken(token);
    if (!record) return null;
    return {
      connectionId: record.connectionId,
      tokenHash: record.hash,
      clientId: record.clientId,
      kind: "oauth",
    };
  }

  isLocalMode(): boolean {
    return this.config.mode === "local" || this.config.mode === "both";
  }

  isOAuthMode(): boolean {
    return this.config.mode === "oauth" || this.config.mode === "both";
  }
}
