/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { AppError } from "../errors.js";
import { backoffMs, parseRetryAfter, sleep } from "../util/async.js";
import type { MultipartBody } from "./multipart.js";
import type { Paged, QueryParams } from "./types.js";

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: QueryParams;
  json?: unknown;
  form?: URLSearchParams;
  multipart?: MultipartBody;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Retries are only automatic for idempotent methods unless set. */
  retryable?: boolean;
  /** Skip the one-shot refresh-and-retry on 401. */
  skipAuthRefresh?: boolean;
  accept?: string;
}

export interface HttpDeps {
  config: Config;
  logger: Logger;
  getAccessToken: (options?: { forceRefresh?: boolean }) => Promise<string>;
  fetchImpl?: typeof fetch;
}

export interface RawResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  text: string;
  url: string;
}

const DEFAULT_API_HOSTS = new Set(["api.soundcloud.com"]);

function appendQuery(url: URL, query: QueryParams): void {
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
}

export class HttpClient {
  private readonly fetchImpl: typeof fetch;
  private readonly allowedHosts: Set<string>;

  constructor(private readonly deps: HttpDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.allowedHosts = new Set(DEFAULT_API_HOSTS);
    try {
      this.allowedHosts.add(new URL(deps.config.sc.apiBase).hostname);
    } catch {
      // apiBase is validated by loadConfig().
    }
  }

  buildUrl(pathOrUrl: string, query?: QueryParams): string {
    if (/^https?:\/\//i.test(pathOrUrl)) {
      const url = new URL(pathOrUrl);
      if (!this.allowedHosts.has(url.hostname)) {
        throw new AppError("BAD_REQUEST", `Refusing to call non-SoundCloud host ${url.hostname}.`, {
          status: 400,
        });
      }
      // Never downgrade a credentialed request from the configured https API to http.
      try {
        if (new URL(this.deps.config.sc.apiBase).protocol === "https:" && url.protocol !== "https:") {
          throw new AppError("BAD_REQUEST", "Refusing to send credentials over plain http.", { status: 400 });
        }
      } catch (error) {
        if (error instanceof AppError) throw error;
      }
      if (query) appendQuery(url, query);
      return url.toString();
    }
    const path = pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`;
    const url = new URL(`${this.deps.config.sc.apiBase}${path}`);
    if (query) appendQuery(url, query);
    return url.toString();
  }

  /** Performs a request and returns parsed JSON (or null for empty bodies). */
  async request<T>(pathOrUrl: string, options: RequestOptions = {}): Promise<T> {
    const raw = await this.requestRaw(pathOrUrl, options);
    if (raw.text.trim().length === 0) return null as T;
    try {
      return JSON.parse(raw.text) as T;
    } catch {
      throw new AppError("INVALID_RESPONSE", "SoundCloud returned a non-JSON response.", {
        status: 502,
        requestId: raw.headers.get("x-request-id") ?? undefined,
        details: raw.text.slice(0, 300),
      });
    }
  }

  /** Lower-level request with retries, auth refresh and SoundCloud error mapping. */
  async requestRaw(pathOrUrl: string, options: RequestOptions = {}): Promise<RawResponse> {
    const method = options.method ?? "GET";
    const url = this.buildUrl(pathOrUrl, options.query);
    const timeoutMs = options.timeoutMs ?? this.deps.config.sc.timeoutMs;
    const idempotent = method === "GET";
    // Retrying a non-idempotent request can duplicate side effects (a second
    // track/comment/playlist), so it is opt-in only.
    const retryAllowed = options.retryable === true || (options.retryable !== false && idempotent);
    const maxRetries = retryAllowed ? this.deps.config.sc.maxRetries : 0;
    let refreshed = false;
    let attempt = 0;

    for (;;) {
      const token = await this.deps.getAccessToken();
      const headers: Record<string, string> = {
        accept: options.accept ?? "application/json; charset=utf-8",
        authorization: `${this.deps.config.sc.authScheme} ${token}`,
        "user-agent": `soundcloud-mcp-server/${this.deps.config.version} (+node)`,
      };
      let body: BodyInit | undefined;
      if (options.json !== undefined) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(options.json);
      } else if (options.form) {
        headers["content-type"] = "application/x-www-form-urlencoded";
        body = options.form.toString();
      } else if (options.multipart) {
        headers["content-type"] = options.multipart.contentType;
        headers["content-length"] = String(options.multipart.contentLength);
        body = options.multipart.body as unknown as BodyInit;
      }

      const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
      if (options.signal) signals.push(options.signal);
      const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);

      const started = Date.now();
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          ...(body !== undefined ? { body } : {}),
          ...(options.multipart ? { duplex: "half" } : {}),
          signal,
        } as RequestInit & { duplex?: "half" });
      } catch (error) {
        if (options.signal?.aborted) {
          throw new AppError("TIMEOUT", "Request aborted by caller.", { status: 499, cause: error });
        }
        if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
          throw new AppError("TIMEOUT", `SoundCloud request timed out after ${timeoutMs} ms.`, {
            status: 504,
            cause: error,
          });
        }
        throw new AppError("NETWORK", error instanceof Error ? error.message : String(error), {
          status: 502,
          cause: error,
        });
      }

      const elapsed = Date.now() - started;
      this.deps.logger.debug("SoundCloud API", {
        method,
        path: url.replace(/\?.*$/, ""),
        status: response.status,
        elapsed_ms: elapsed,
        attempt,
      });

      if (response.status === 401 && !refreshed && !options.skipAuthRefresh && options.multipart === undefined) {
        refreshed = true;
        await response.body?.cancel().catch(() => undefined);
        await this.deps.getAccessToken({ forceRefresh: true });
        continue;
      }

      if ((response.status === 429 || response.status >= 500) && retryAllowed && attempt < maxRetries) {
        await response.body?.cancel().catch(() => undefined);
        const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
        const delay = retryAfter ?? backoffMs(attempt, 500, 8_000);
        attempt += 1;
        await sleep(Math.min(delay, 30_000), options.signal);
        continue;
      }

      const text = await response.text().catch(() => "");
      const raw: RawResponse = {
        status: response.status,
        ok: response.ok,
        headers: response.headers,
        text,
        url,
      };

      if (!response.ok) throw this.mapError(raw);
      return raw;
    }
  }

  /** Follows SoundCloud's linked_partitioning cursor. */
  async paginate<T>(
    pathOrUrl: string,
    options: Omit<RequestOptions, "method"> & { maxItems?: number; pageSize?: number; cursor?: string | null } = {}
  ): Promise<Paged<T>> {
    const maxItems = options.maxItems ?? 100;
    const pageSize = Math.min(options.pageSize ?? 50, 200);
    const items: T[] = [];
    let next: string | null = options.cursor ?? null;
    let first = true;
    let guard = 0;

    while (items.length < maxItems) {
      if (guard++ > 50) break;
      const remaining = Math.max(1, maxItems - items.length);
      const query = next
        ? undefined
        : { ...(options.query ?? {}), linked_partitioning: 1, limit: Math.min(pageSize, remaining) };
      const raw = await this.requestRaw(next ?? pathOrUrl, {
        ...options,
        ...(query ? { query } : {}),
      });
      let parsed: unknown;
      try {
        parsed = raw.text.trim().length === 0 ? null : JSON.parse(raw.text);
      } catch {
        throw new AppError("INVALID_RESPONSE", "SoundCloud pagination response is not JSON.", {
          status: 502,
          details: raw.text.slice(0, 200),
        });
      }

      if (Array.isArray(parsed)) {
        items.push(...(parsed as T[]));
        next = null;
        break;
      }

      const page = parsed as { collection?: T[]; next_href?: string | null };
      if (!Array.isArray(page.collection)) {
        throw new AppError("INVALID_RESPONSE", "SoundCloud pagination response has no collection.", {
          status: 502,
        });
      }
      items.push(...page.collection);
      next = typeof page.next_href === "string" && page.next_href.length > 0 ? page.next_href : null;
      first = false;
      if (!next) break;
    }

    void first;
    return {
      // maxItems is a soft cap: a server page may overshoot it. Returning the
      // whole page avoids silently dropping items with no cursor to recover.
      items,
      next,
    };
  }

  private mapError(raw: RawResponse): AppError {
    const requestId = raw.headers.get("x-request-id") ?? undefined;
    const snippet = raw.text.slice(0, 800);
    let parsed: { message?: string; error?: string; error_description?: string; code?: string } | null = null;
    try {
      parsed = JSON.parse(raw.text) as { message?: string; error?: string; error_description?: string; code?: string };
    } catch {
      parsed = null;
    }
    const message =
      parsed?.error_description ??
      parsed?.message ??
      parsed?.error ??
      `SoundCloud API error (HTTP ${raw.status}).`;

    switch (raw.status) {
      case 400:
      case 422:
        return new AppError("BAD_REQUEST", message, { status: raw.status, requestId, details: snippet });
      case 401:
        return new AppError("TOKEN_EXPIRED", message, { status: 401, requestId, details: snippet });
      case 403:
        return new AppError("FORBIDDEN", message, { status: 403, requestId, details: snippet });
      case 404:
        return new AppError("NOT_FOUND", message, { status: 404, requestId });
      case 409:
        return new AppError("CONFLICT", message, { status: 409, requestId, details: snippet });
      case 413:
        return new AppError("UPLOAD_TOO_LARGE", message, { status: 413, requestId });
      case 429:
        return new AppError("RATE_LIMITED", message, {
          status: 429,
          requestId,
          retryAfterSeconds: Math.round((parseRetryAfter(raw.headers.get("retry-after")) ?? 60_000) / 1000),
        });
      default:
        return new AppError("API_ERROR", message, {
          status: raw.status,
          requestId,
          details: snippet,
        });
    }
  }
}
