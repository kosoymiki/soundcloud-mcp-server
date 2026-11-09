/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type ResourceKind = "tracks" | "playlists" | "users" | "comments" | "system-playlists";

const API_HOST = "api.soundcloud.com";

/**
 * SoundCloud accepts numeric ids for backwards compatibility, but the public
 * spec (2026) documents URNs and deprecates numeric ids. All outbound paths use
 * URNs; this module is the single place that parses user input.
 */
export function toUrn(kind: ResourceKind, input: string | number): string {
  const raw = String(input).trim();
  if (raw.length === 0) throw new InvalidIdentifierError(kind, input, "empty identifier");

  // URN already (including system-playlists, which has an extra segment).
  if (raw.startsWith(`soundcloud:${kind}:`)) {
    const rest = raw.slice(`soundcloud:${kind}:`.length);
    if (!/^[A-Za-z0-9:_-]+$/.test(rest)) {
      throw new InvalidIdentifierError(kind, input, "invalid URN characters");
    }
    return raw;
  }

  // API URL: https://api.soundcloud.com/tracks/123
  if (/^https?:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new InvalidIdentifierError(kind, input, "malformed URL");
    }
    if (url.hostname !== API_HOST) {
      throw new InvalidIdentifierError(kind, input, `only ${API_HOST} URLs are accepted`);
    }
    const segments = url.pathname.split("/").filter(Boolean);
    const index = segments.indexOf(kind);
    if (index === -1 || segments.length <= index + 1) {
      throw new InvalidIdentifierError(kind, input, `URL does not contain /${kind}/{id}`);
    }
    const id = segments.slice(index + 1).join(":");
    return toUrn(kind, id);
  }

  if (!/^[0-9]+$/.test(raw)) {
    throw new InvalidIdentifierError(kind, input, "expected a numeric id or a soundcloud URN");
  }
  return `soundcloud:${kind}:${raw}`;
}

export function isUrn(value: string): boolean {
  return /^soundcloud:[a-z-]+:[A-Za-z0-9:_-]+$/.test(value);
}

/** Extract the numeric id from a URN; returns null for composite URNs. */
export function numericIdFromUrn(urn: string): string | null {
  const match = /^soundcloud:[a-z-]+:([0-9]+)$/.exec(urn);
  return match?.[1] ?? null;
}

export class InvalidIdentifierError extends Error {
  readonly code = "INVALID_IDENTIFIER";

  constructor(kind: ResourceKind, input: unknown, reason: string) {
    super(`Invalid ${kind} identifier ${JSON.stringify(input)}: ${reason}`);
    this.name = "InvalidIdentifierError";
  }
}
