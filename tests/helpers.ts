/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { loadConfig, type Config, type McpMode } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { Store } from "../src/auth/store.js";
import { createApp, type ServerHandle } from "../src/server.js";

export function testConfig(options: { mode?: McpMode; publicUrl?: string; port?: number } = {}): Config {
  const dataDir = mkdtempSync(join(tmpdir(), "scmcp-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.MCP_LOCAL_TOKEN = "test-local-token-0123456789";
  process.env.MCP_MODE = options.mode ?? "local";
  process.env.PUBLIC_URL = options.publicUrl ?? `http://127.0.0.1:${options.port ?? 3000}`;
  process.env.LOG_LEVEL = "error";
  process.env.SC_CLIENT_ID = "test-client-id";
  process.env.SC_CLIENT_SECRET = "test-client-secret";
  process.env.SC_MEDIA_DIRS = dataDir;
  process.env.MCP_JSON_RESPONSE = "true";
  const config = loadConfig();
  if (options.port !== undefined) config.port = options.port;
  return config;
}

export function seedLocalConnection(config: Config, accessToken = "sc-access-token"): Store {
  const logger = createLogger("error");
  const store = new Store(config, logger);
  store.ensureLocalConnection({
    accessToken,
    refreshToken: "sc-refresh-token",
    clientId: config.sc.clientId,
    clientSecret: config.sc.clientSecret,
    expiresIn: 3600,
  });
  return store;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

export async function startApp(config: Config): Promise<ServerHandle> {
  const handle = createApp(config, createLogger("error"));
  // Always wait for the socket: without this a caller can issue requests (or
  // block the loop with spawnSync) before listen() has completed.
  await new Promise<void>((resolve, reject) => {
    if (handle.server.listening) {
      resolve();
      return;
    }
    const onListening = (): void => {
      handle.server.off("error", onError);
      resolve();
    };
    const onError = (error: Error): void => {
      handle.server.off("listening", onListening);
      reject(error);
    };
    handle.server.once("listening", onListening);
    handle.server.once("error", onError);
  });
  if (config.port === 0) {
    const address = handle.server.address() as AddressInfo;
    config.port = address.port;
    handle.url = `http://127.0.0.1:${address.port}`;
  }
  return handle;
}

export function appUrl(config: Config): string {
  return `http://127.0.0.1:${config.port}`;
}
