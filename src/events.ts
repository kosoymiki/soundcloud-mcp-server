/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { EventEmitter } from "node:events";

export type ServerEvent =
  | { type: "upload.progress"; uploadId: string; sent: number; total: number; percent: number }
  | { type: "upload.done"; uploadId: string; trackUrn: string; title: string }
  | { type: "upload.error"; uploadId: string; message: string }
  | { type: "audio.progress"; jobId: string; operation: string; percent: number; elapsedSeconds: number }
  | { type: "api.call"; method: string; path: string; status: number; elapsedMs: number }
  | { type: "log"; level: "info" | "warn" | "error"; message: string };

export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  publish(event: ServerEvent): void {
    this.emitter.emit("event", event);
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  get listenerCount(): number {
    return this.emitter.listenerCount("event");
  }

  dispose(): void {
    this.emitter.removeAllListeners();
  }
}
