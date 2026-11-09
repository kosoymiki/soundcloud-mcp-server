/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export interface TtlEntry<V> {
  value: V;
  expiresAt: number;
}

/** Map with per-entry TTL and an optional unref'd sweeper. */
export class TtlMap<K, V> {
  private readonly map = new Map<K, TtlEntry<V>>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly sweepIntervalMs = 60_000) {}

  set(key: K, value: V, ttlMs: number): void {
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
    this.ensureSweeper();
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** Get and refresh the TTL. */
  touch(key: K, ttlMs: number): V | undefined {
    const value = this.get(key);
    if (value !== undefined) this.set(key, value, ttlMs);
    return value;
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    this.sweep();
    return this.map.size;
  }

  entries(): Array<[K, V]> {
    this.sweep();
    return Array.from(this.map.entries(), ([key, entry]) => [key, entry.value]);
  }

  sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.map) {
      if (entry.expiresAt <= now) this.map.delete(key);
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private ensureSweeper(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), this.sweepIntervalMs);
    this.timer.unref();
  }
}
