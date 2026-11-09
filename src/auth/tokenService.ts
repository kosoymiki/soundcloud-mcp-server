/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { Connection, Store } from "./store.js";
import { AppError, NeedsReauthError } from "../errors.js";
import { SingleFlight, backoffMs, parseRetryAfter, sleep } from "../util/async.js";

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

export class TokenService {
  private readonly singleFlight = new SingleFlight<string, Connection>();

  constructor(
    private readonly store: Store,
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  /** Returns a valid SoundCloud access token, refreshing when it is close to expiry. */
  async getAccessToken(connectionId: string, options: { forceRefresh?: boolean } = {}): Promise<string> {
    const connection = this.store.getConnection(connectionId);
    if (!connection) throw new NeedsReauthError("No SoundCloud connection for this session.");

    if (!options.forceRefresh && connection.scAccessToken && connection.scExpiresAt - Date.now() > 60_000) {
      return connection.scAccessToken;
    }
    const refreshed = await this.refresh(connectionId);
    return refreshed.scAccessToken;
  }

  refresh(connectionId: string): Promise<Connection> {
    return this.singleFlight.run(connectionId, async () => {
      const connection = this.store.getConnection(connectionId);
      if (!connection) throw new NeedsReauthError("No SoundCloud connection for this session.");
      return this.doRefresh(connection);
    });
  }

  private async doRefresh(connection: Connection): Promise<Connection> {
    if (!connection.scRefreshToken) {
      throw new NeedsReauthError(
        "The SoundCloud access token expired and no refresh token is stored. Reconnect SoundCloud."
      );
    }
    if (!connection.scClientId || !connection.scClientSecret) {
      throw new NeedsReauthError(
        "The SoundCloud access token expired and no client credentials are stored for refresh. Reconnect SoundCloud."
      );
    }

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: connection.scRefreshToken,
      client_id: connection.scClientId,
      client_secret: connection.scClientSecret,
    });

    let attempt = 0;
    let lastError: unknown;
    while (attempt <= 1) {
      const started = Date.now();
      try {
        const response = await this.fetchImpl(this.config.sc.tokenUrl, {
          method: "POST",
          headers: {
            accept: "application/json; charset=utf-8",
            "content-type": "application/x-www-form-urlencoded",
          },
          body,
          signal: AbortSignal.timeout(this.config.sc.timeoutMs),
        });
        const text = await response.text();
        this.logger.debug("SoundCloud token refresh", {
          status: response.status,
          elapsed_ms: Date.now() - started,
          attempt,
        });

        if (!response.ok) {
          const retryable = response.status === 429 || response.status >= 500;
          if (retryable && attempt === 0) {
            const delay = parseRetryAfter(response.headers.get("retry-after")) ?? backoffMs(attempt, 500, 4_000);
            attempt += 1;
            await sleep(Math.min(delay, 10_000));
            continue;
          }
          if (response.status === 400 || response.status === 401 || response.status === 403) {
            // Single-use refresh tokens are burned on use; an invalid_grant here
            // means the stored token can never work again.
            this.store.upsertConnection({ ...connection, needsReauth: true, updatedAt: Date.now() });
            throw new NeedsReauthError(
              `SoundCloud rejected the refresh token (HTTP ${response.status}). Reconnect SoundCloud.`
            );
          }
          throw new AppError("API_ERROR", `SoundCloud token refresh failed (HTTP ${response.status}).`, {
            status: 502,
            details: text.slice(0, 500),
          });
        }

        let parsed: TokenResponse;
        try {
          parsed = JSON.parse(text) as TokenResponse;
        } catch {
          throw new AppError("INVALID_RESPONSE", "SoundCloud token refresh returned invalid JSON.", {
            status: 502,
          });
        }
        if (typeof parsed.access_token !== "string" || parsed.access_token.length < 10) {
          throw new AppError("INVALID_RESPONSE", "SoundCloud token refresh response has no access_token.", {
            status: 502,
          });
        }

        const expiresIn = typeof parsed.expires_in === "number" ? parsed.expires_in : 3600;
        const updated: Connection = {
          ...connection,
          scAccessToken: parsed.access_token,
          scRefreshToken: typeof parsed.refresh_token === "string" ? parsed.refresh_token : connection.scRefreshToken,
          scExpiresAt: Date.now() + Math.max(30, expiresIn) * 1000,
          scopes: typeof parsed.scope === "string" ? parsed.scope : connection.scopes,
          needsReauth: false,
          updatedAt: Date.now(),
        };
        // Persist before returning: the old refresh token is single-use, so a
        // crash after this point must not lose the rotated value.
        this.store.upsertConnection(updated);
        this.logger.info("SoundCloud token refreshed", { connection: connection.id, expires_in: expiresIn });
        return updated;
      } catch (error) {
        if (error instanceof AppError) throw error;
        lastError = error;
        if (attempt === 0) {
          attempt += 1;
          await sleep(backoffMs(0, 300, 2_000));
          continue;
        }
      }
    }

    throw new AppError("NETWORK", "SoundCloud token refresh failed after retry.", {
      status: 502,
      cause: lastError,
    });
  }
}
