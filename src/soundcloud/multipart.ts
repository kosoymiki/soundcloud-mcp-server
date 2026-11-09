/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createReadStream, statSync } from "node:fs";
import { basename } from "node:path";
import { randomBytes } from "node:crypto";

export interface FilePart {
  path: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface MultipartBody {
  body: ReadableStream<Uint8Array>;
  contentLength: number;
  contentType: string;
}

export type MultipartFieldValue = string | number | boolean | null | undefined;

function escapeQuoted(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r|\n/g, " ");
}

function fieldPart(boundary: string, name: string, value: string): Buffer {
  return Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${escapeQuoted(name)}"\r\n\r\n` +
      `${value}\r\n`,
    "utf8"
  );
}

function fileHeader(boundary: string, name: string, filename: string, contentType: string): Buffer {
  return Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${escapeQuoted(name)}"; filename="${escapeQuoted(filename)}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
    "utf8"
  );
}

export function guessContentType(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "mp3":
      return "audio/mpeg";
    case "wav":
    case "wave":
      return "audio/wav";
    case "flac":
      return "audio/flac";
    case "aiff":
    case "aif":
      return "audio/aiff";
    case "ogg":
    case "oga":
      return "audio/ogg";
    case "m4a":
    case "aac":
      return "audio/mp4";
    case "wma":
      return "audio/x-ms-wma";
    case "amr":
      return "audio/amr";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

export function makeFilePart(path: string, filename?: string, contentType?: string): FilePart {
  const stats = statSync(path);
  if (!stats.isFile()) throw new Error(`${path} is not a regular file`);
  const name = filename ?? basename(path);
  return {
    path,
    filename: name,
    contentType: contentType ?? guessContentType(name),
    size: stats.size,
  };
}

/**
 * Streams a multipart/form-data body without buffering the file in memory.
 * `pull` provides backpressure: a 4 GB upload never materializes in RAM.
 */
export function createMultipart(
  fields: Record<string, MultipartFieldValue>,
  file: FilePart,
  fileField: string,
  onProgress?: (sentBytes: number, totalBytes: number) => void
): MultipartBody {
  const boundary = `----scmcp${randomBytes(12).toString("hex")}`;
  const headerChunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    headerChunks.push(fieldPart(boundary, name, String(value)));
  }
  headerChunks.push(fileHeader(boundary, fileField, file.filename, file.contentType));
  const header = Buffer.concat(headerChunks);
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const total = header.length + file.size + footer.length;

  let phase: "header" | "file" | "footer" = "header";
  let sent = 0;
  let reader: AsyncIterator<Buffer> | null = null;

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (phase === "header") {
        controller.enqueue(new Uint8Array(header));
        sent += header.length;
        phase = "file";
        onProgress?.(sent, total);
        return;
      }

      if (phase === "file") {
        reader ??= createReadStream(file.path, { highWaterMark: 1024 * 1024 })[Symbol.asyncIterator]();
        const next = await reader.next();
        if (!next.done) {
          const chunk = next.value as Buffer;
          controller.enqueue(new Uint8Array(chunk));
          sent += chunk.length;
          onProgress?.(sent, total);
          return;
        }
        phase = "footer";
      }

      controller.enqueue(new Uint8Array(footer));
      sent += footer.length;
      onProgress?.(sent, total);
      controller.close();
    },
    async cancel(reason) {
      if (reader && typeof reader.return === "function") {
        await reader.return().catch(() => undefined);
      }
      void reason;
    },
  });

  return { body, contentLength: total, contentType: `multipart/form-data; boundary=${boundary}` };
}
