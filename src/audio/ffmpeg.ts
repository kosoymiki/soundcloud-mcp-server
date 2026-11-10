/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { spawn } from "node:child_process";
import { AppError } from "../errors.js";

export interface FfmpegRunOptions {
  onProgress?: (seconds: number, percent: number) => void;
  durationSeconds?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ProbeResult {
  path: string;
  size: number;
  durationSeconds: number;
  bitrate: number | null;
  sampleRate: number | null;
  channels: number | null;
  codec: string;
  container: string;
  tags: Record<string, string>;
}

interface RunnerResult {
  stdout: string;
  stderr: string;
  code: number;
}

function run(
  binary: string,
  args: string[],
  options: { timeoutMs: number; signal?: AbortSignal; onStdout?: (line: string) => void }
): Promise<RunnerResult> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(new AppError("INTERNAL", `Cannot start ${binary}: ${(error as Error).message}`, { status: 500 }));
      return;
    }

    let stdout = "";
    let stderr = "";
    let pending = "";
    let settled = false;
    const finish = (error: Error | null, code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve({ stdout, stderr, code });
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new AppError("TIMEOUT", `${binary} exceeded ${Math.round(options.timeoutMs / 1000)}s.`, { status: 504 }), -1);
    }, options.timeoutMs);
    timer.unref();

    const onAbort = (): void => {
      child.kill("SIGKILL");
      finish(new AppError("TIMEOUT", `${binary} aborted by caller.`, { status: 499 }), -1);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      if (stdout.length > 2_000_000) stdout = stdout.slice(-1_000_000);
      if (options.onStdout) {
        pending += text;
        let index = pending.indexOf("\n");
        while (index !== -1) {
          const line = pending.slice(0, index).trim();
          pending = pending.slice(index + 1);
          if (line.length > 0) options.onStdout(line);
          index = pending.indexOf("\n");
        }
        // Progress keys can be split across chunks; keep an incomplete tail.
        if (pending.length > 64_000) pending = pending.slice(-32_000);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
    });
    child.on("error", (error) => {
      finish(new AppError("INTERNAL", `Failed to run ${binary}: ${error.message}`, { status: 500 }), -1);
    });
    child.on("close", (code) => {
      if (code === 0) finish(null, 0);
      else
        finish(
          new AppError("API_ERROR", `${binary} exited with code ${code}: ${stderr.slice(-1200)}`, {
            status: 422,
            details: { stderr: stderr.slice(-3000) },
          }),
          code ?? -1
        );
    });
  });
}

export async function runFfmpeg(
  binary: string,
  args: string[],
  options: FfmpegRunOptions = {}
): Promise<void> {
  let outSeconds = 0;
  await run(binary, args, {
    timeoutMs: options.timeoutMs ?? 30 * 60_000,
    ...(options.signal ? { signal: options.signal } : {}),
    onStdout: (line) => {
      const [key, value] = line.split("=", 2);
      if (key === "out_time_us" || key === "out_time_ms") {
        const micros = Number(value);
        if (Number.isFinite(micros) && micros >= 0) outSeconds = micros / 1_000_000;
      } else if (key === "out_time") {
        const match = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(value ?? "");
        if (match) {
          outSeconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
        }
      }
      const percent =
        options.durationSeconds && options.durationSeconds > 0
          ? Math.min(99, Math.round((outSeconds / options.durationSeconds) * 100))
          : 0;
      options.onProgress?.(outSeconds, percent);
    },
  });
}

export async function probeMedia(binary: string, path: string): Promise<ProbeResult> {
  const result = await run(
    binary,
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
    { timeoutMs: 60_000 }
  );
  let parsed: {
    format?: {
      duration?: string;
      bit_rate?: string;
      size?: string;
      format_name?: string;
      tags?: Record<string, string>;
    };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      sample_rate?: string;
      channels?: number;
      duration?: string;
    }>;
  };
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new AppError("INVALID_RESPONSE", `ffprobe returned invalid JSON for ${path}.`, { status: 502 });
  }

  const audio = parsed.streams?.find((stream) => stream.codec_type === "audio") ?? parsed.streams?.[0];
  if (!audio) throw new AppError("UNSUPPORTED_MEDIA", `No audio stream found in ${path}.`, { status: 415 });

  const duration = Number(parsed.format?.duration ?? audio.duration ?? 0);
  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed.format?.tags ?? {})) {
    tags[key] = value;
  }

  return {
    path,
    size: Number(parsed.format?.size ?? 0),
    durationSeconds: Number.isFinite(duration) ? duration : 0,
    bitrate: parsed.format?.bit_rate ? Number(parsed.format.bit_rate) : null,
    sampleRate: audio.sample_rate ? Number(audio.sample_rate) : null,
    channels: typeof audio.channels === "number" ? audio.channels : null,
    codec: audio.codec_name ?? "unknown",
    container: parsed.format?.format_name ?? "unknown",
    tags,
  };
}

/** Parse `ffmpeg -filters` output; the flag column is `..`, `...` or `TS` across builds. */
export function parseFilterList(output: string): Set<string> {
  const filters = new Set<string>();
  for (const line of output.split("\n")) {
    const parts = line.trim().split(/\s+/);
    for (let index = 1; index < parts.length; index += 1) {
      if (/^[AVN|]+->[AVN|]+$/.test(parts[index] ?? "")) {
        const name = parts[index - 1];
        if (name && /^[A-Za-z0-9_]+$/.test(name)) filters.add(name);
        break;
      }
    }
  }
  return filters;
}

export async function listFilters(binary: string): Promise<Set<string>> {
  const result = await run(binary, ["-hide_banner", "-filters"], { timeoutMs: 30_000 });
  return parseFilterList(result.stdout);
}
