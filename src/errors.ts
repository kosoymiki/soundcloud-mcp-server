/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type ErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "TOKEN_EXPIRED"
  | "NEEDS_REAUTH"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "UPLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA"
  | "TIMEOUT"
  | "NETWORK"
  | "API_ERROR"
  | "INVALID_RESPONSE"
  | "INTERNAL";

export interface SerializedError {
  error: true;
  code: ErrorCode;
  message: string;
  status?: number;
  retry_after_seconds?: number;
  request_id?: string;
  details?: unknown;
}

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly options: {
      status?: number;
      retryAfterSeconds?: number;
      requestId?: string;
      details?: unknown;
      cause?: unknown;
    } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
  }

  toJSON(): SerializedError {
    return {
      error: true,
      code: this.code,
      message: this.message,
      ...(this.options.status !== undefined ? { status: this.options.status } : {}),
      ...(this.options.retryAfterSeconds !== undefined
        ? { retry_after_seconds: this.options.retryAfterSeconds }
        : {}),
      ...(this.options.requestId ? { request_id: this.options.requestId } : {}),
      ...(this.options.details !== undefined ? { details: this.options.details } : {}),
    };
  }
}

export class NeedsReauthError extends AppError {
  constructor(message = "SoundCloud authorization expired. Reconnect your SoundCloud account.") {
    super("NEEDS_REAUTH", message, { status: 401 });
    this.name = "NeedsReauthError";
  }
}

export class InvalidInputError extends AppError {
  constructor(message: string, details?: unknown) {
    super("BAD_REQUEST", message, { status: 400, details });
    this.name = "InvalidInputError";
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return new AppError("TIMEOUT", error.message, { status: 504, cause: error });
    }
    if (error instanceof TypeError && /fetch failed|network/i.test(error.message)) {
      return new AppError("NETWORK", error.message, { status: 502, cause: error });
    }
    return new AppError("INTERNAL", error.message, { status: 500, cause: error });
  }
  return new AppError("INTERNAL", String(error), { status: 500 });
}

export function errorToMcp(error: unknown): { isError: true; content: Array<{ type: "text"; text: string }> } {
  const appError = toAppError(error);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(appError.toJSON(), null, 2) }],
  };
}
