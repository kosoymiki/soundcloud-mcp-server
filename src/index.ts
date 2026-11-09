#!/usr/bin/env node
/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { join } from "node:path";
import { loadConfig } from "./config.js";
import { createLogger, redact } from "./logger.js";
import { Store } from "./auth/store.js";
import { createApp, guardMode } from "./server.js";

function bootstrapLocalConnection(config: ReturnType<typeof loadConfig>, logger: ReturnType<typeof createLogger>): void {
  if (config.mode === "oauth") return;
  const accessToken = process.env.SC_ACCESS_TOKEN?.trim();
  if (!accessToken) return;

  const store = new Store(config, logger);
  try {
    const existing = store.getConnection("local");
    const refreshToken = process.env.SC_REFRESH_TOKEN?.trim();
    if (existing && existing.scAccessToken === accessToken && (!refreshToken || existing.scRefreshToken === refreshToken)) {
      return;
    }
    const expiresIn = Number.parseInt(process.env.SC_ACCESS_TOKEN_EXPIRES_IN ?? "3600", 10);
    store.ensureLocalConnection({
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      ...(config.sc.clientId ? { clientId: config.sc.clientId } : {}),
      ...(config.sc.clientSecret ? { clientSecret: config.sc.clientSecret } : {}),
      ...(Number.isFinite(expiresIn) ? { expiresIn } : {}),
    });
    logger.info("Local SoundCloud connection bootstrapped from environment", {
      refresh: Boolean(refreshToken),
    });
  } finally {
    store.dispose();
  }
}

function main(): void {
  const config = loadConfig();
  guardMode(config);
  const logger = createLogger(config.logLevel);
  bootstrapLocalConnection(config, logger);

  const handle = createApp(config, logger);
  const localTokenPath = join(config.dataDir, "local-token");

  logger.info("SoundCloud MCP server listening", {
    url: handle.url,
    public_url: config.publicUrl,
    mode: config.mode,
    mcp: `${config.publicUrl}/mcp`,
    panel: `${config.publicUrl}/panel`,
  });
  const lines = [
    `SoundCloud MCP Server v${config.version}`,
    `  listening:      ${handle.url}`,
    `  public URL:     ${config.publicUrl}`,
    `  MCP endpoint:   ${config.publicUrl}/mcp`,
    `  control panel:  ${config.publicUrl}/panel`,
    `  health:         ${config.publicUrl}/health`,
    `  mode:           ${config.mode}`,
    `  data dir:       ${config.dataDir}`,
    `  local token:    ${localTokenPath} (mode=local/both)`,
    `  debug:          ${config.debug ? "enabled" : "disabled"}`,
  ];
  process.stdout.write(`${redact(lines.join("\n"))}\n`);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down", { signal });
    const timer = setTimeout(() => {
      logger.warn("Forcing exit after shutdown timeout");
      process.exit(1);
    }, 5_000);
    timer.unref();
    void handle
      .close()
      .then(() => {
        logger.info("Shutdown complete");
        process.exit(0);
      })
      .catch((error: unknown) => {
        logger.error("Shutdown failed", { error: error instanceof Error ? error.message : String(error) });
        process.exit(1);
      });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled rejection", { error: reason instanceof Error ? reason.message : String(reason) });
  });
}

main();
