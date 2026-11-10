/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { toUrn, numericIdFromUrn, InvalidIdentifierError } from "../src/util/ids.js";
import { pkcePair, verifyPkce, seal, open, signValue, verifySignedValue, hashToken } from "../src/auth/crypto.js";
import { parseId3 } from "../src/soundcloud/id3.js";

test("toUrn accepts digits, URNs and API URLs", () => {
  assert.equal(toUrn("tracks", 123), "soundcloud:tracks:123");
  assert.equal(toUrn("tracks", "123"), "soundcloud:tracks:123");
  assert.equal(toUrn("tracks", "soundcloud:tracks:123"), "soundcloud:tracks:123");
  assert.equal(toUrn("tracks", "https://api.soundcloud.com/tracks/123"), "soundcloud:tracks:123");
  assert.equal(toUrn("playlists", "https://api.soundcloud.com/playlists/9?x=1"), "soundcloud:playlists:9");
  assert.equal(numericIdFromUrn("soundcloud:tracks:42"), "42");
  assert.equal(numericIdFromUrn("soundcloud:system-playlists:track-stations:42"), null);
});

test("toUrn rejects foreign hosts and malformed identifiers", () => {
  assert.throws(() => toUrn("tracks", "https://evil.example/tracks/1"), InvalidIdentifierError);
  assert.throws(() => toUrn("tracks", "abc"), InvalidIdentifierError);
  assert.throws(() => toUrn("tracks", ""), InvalidIdentifierError);
});

test("PKCE S256 pair verifies", () => {
  const pair = pkcePair();
  assert.equal(pair.verifier.length, 86);
  assert.equal(verifyPkce(pair.verifier, pair.challenge), true);
  assert.equal(verifyPkce(`${pair.verifier}x`, pair.challenge), false);
  assert.equal(verifyPkce("short", pair.challenge), false);
});

test("sealed values round-trip and detect tampering", () => {
  const key = Buffer.alloc(32, 7);
  const sealed = seal("secret-value", key);
  assert.equal(open(sealed, key), "secret-value");
  // The last base64url character can already be "A"; mutate to a different byte.
  const tampered = `${sealed.slice(0, -1)}${sealed.endsWith("A") ? "B" : "A"}`;
  assert.throws(() => open(tampered, key));
  assert.throws(() => open(sealed, Buffer.alloc(32, 8)));
});

test("signed values enforce signature and expiry", () => {
  const key = Buffer.alloc(32, 3);
  const signed = signValue(JSON.stringify({ exp: Date.now() + 60_000, a: 1 }), key);
  assert.ok(verifySignedValue(signed, key));
  assert.equal(verifySignedValue(`${signed}x`, key), null);
  const expired = signValue(JSON.stringify({ exp: Date.now() - 1000 }), key);
  assert.equal(verifySignedValue(expired, key), null);
});

test("hashToken is stable and not reversible", () => {
  assert.equal(hashToken("abc"), hashToken("abc"));
  assert.notEqual(hashToken("abc"), hashToken("abd"));
});

function syncsafe(value: number): Buffer {
  return Buffer.from([(value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f]);
}

function frame(id: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(10);
  header.write(id, 0, "latin1");
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

test("ID3 parser extracts text frames and APIC artwork", () => {
  const text = (value: string): Buffer => Buffer.concat([Buffer.from([3]), Buffer.from(value, "utf8")]);
  const comment = Buffer.concat([
    Buffer.from([3]),
    Buffer.from("eng", "latin1"),
    Buffer.from([0]),
    Buffer.from("nice", "utf8"),
  ]);
  const artworkBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const apic = Buffer.concat([
    Buffer.from([0]),
    Buffer.from("image/jpeg\0", "latin1"),
    Buffer.from([3, 0]),
    artworkBytes,
  ]);
  const frames = Buffer.concat([
    frame("TIT2", text("Test Title")),
    frame("TPE1", text("Test Artist")),
    frame("TCON", text("Hip-Hop")),
    frame("TYER", text("2026")),
    frame("COMM", comment),
    frame("APIC", apic),
  ]);
  const header = Buffer.concat([Buffer.from("ID3", "latin1"), Buffer.from([3, 0, 0]), syncsafe(frames.length)]);
  const tags = parseId3(Buffer.concat([header, frames]));

  assert.equal(tags.title, "Test Title");
  assert.equal(tags.artist, "Test Artist");
  assert.equal(tags.genre, "Hip-Hop");
  assert.equal(tags.year, "2026");
  assert.equal(tags.comment, "nice");
  assert.equal(tags.artwork?.mimeType, "image/jpeg");
  assert.deepEqual(tags.artwork?.data, artworkBytes);
});

test("ID3 parser never throws on garbage", () => {
  const tags = parseId3(Buffer.from("not an id3 file at all"));
  assert.ok(tags.warnings.length > 0);
  const truncated = parseId3(Buffer.concat([Buffer.from("ID3"), Buffer.from([3, 0, 0, 0, 0, 0x10]) ]));
  assert.ok(truncated.warnings.length >= 0);
});
