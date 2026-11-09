/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { EventBus } from "../events.js";
import type { SoundCloudApi } from "../soundcloud/api.js";
import type { UploadService } from "../uploads/service.js";
import type { AudioService } from "../audio/service.js";

export interface ToolContext {
  api: SoundCloudApi;
  uploads: UploadService;
  audio: AudioService;
  config: Config;
  logger: Logger;
  events: EventBus;
  connectionId: string;
  isLoopback: boolean;
}
