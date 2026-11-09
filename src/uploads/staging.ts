/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

/** Removes stale staged uploads so DATA_DIR/uploads cannot grow forever. */
export async function pruneStagedUploads(dir: string, maxAgeMs = 24 * 3600 * 1000): Promise<number> {
  let removed = 0;
  try {
    const entries = await readdir(dir);
    const now = Date.now();
    for (const entry of entries) {
      const path = join(dir, entry);
      try {
        const info = await stat(path);
        if (info.isFile() && now - info.mtimeMs > maxAgeMs) {
          await unlink(path);
          removed += 1;
        }
      } catch {
        // Ignore races on individual files.
      }
    }
  } catch {
    // Directory does not exist yet.
  }
  return removed;
}
