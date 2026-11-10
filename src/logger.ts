/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(access_token|refresh_token|client_secret|code_verifier|code)=([^\s&,"']+)/gi, "$1=[REDACTED]"],
  [/(Authorization:\s*(?:OAuth|Bearer))\s+[^\s,"']+/gi, "$1 [REDACTED]"],
  [/((?:authorization|cookie|set-cookie|oauth_token|sc_session|datadome)"?\s*[:=]\s*"?)([^\s,"']{6,})/gi, "$1[REDACTED]"],
  [/("(?:access_token|refresh_token|client_secret|sc_access_token|sc_refresh_token|cookie)"\s*:\s*")[^"]+/gi, "$1[REDACTED]"],
  [/(scmcp_(?:at|rt)_[A-Za-z0-9_-]{8,})/g, "[REDACTED_TOKEN]"],
];

export function redact(input: string): string {
  let output = input;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export class Logger {
  constructor(
    private readonly level: LogLevel,
    private readonly fields: Record<string, unknown> = {}
  ) {}

  child(fields: Record<string, unknown>): Logger {
    return new Logger(this.level, { ...this.fields, ...fields });
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.write("debug", message, fields);
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.write("info", message, fields);
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.write("warn", message, fields);
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.write("error", message, fields);
  }

  private write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const entry = {
      ts: new Date().toISOString(),
      level,
      msg: redact(message),
      ...this.fields,
      ...(fields ?? {}),
    };
    let line: string;
    try {
      line = redact(JSON.stringify(entry, (_key, value) => (value instanceof Error ? stringify(value) : value)));
    } catch {
      line = `${JSON.stringify({ ts: entry.ts, level, msg: entry.msg })}`;
    }
    process.stderr.write(`${line}\n`);
  }
}

export function createLogger(level: LogLevel): Logger {
  return new Logger(level);
}
