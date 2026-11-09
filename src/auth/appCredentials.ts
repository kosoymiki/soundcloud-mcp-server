/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { Config } from "../config.js";
import type { Store } from "./store.js";

/**
 * SoundCloud app credentials can come from the environment (personal device) or
 * from the encrypted store (entered once through the loopback setup page).
 * Environment wins so a deployer can rotate without touching state.
 */
export function resolveAppCredentials(
  config: Config,
  store: Store
): { clientId: string; clientSecret: string } | null {
  if (config.sc.clientId && config.sc.clientSecret) {
    return { clientId: config.sc.clientId, clientSecret: config.sc.clientSecret };
  }
  return store.getAppCredentials();
}
