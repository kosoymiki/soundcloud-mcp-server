/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AppError } from "../src/errors.js";
import {
  chromeCookieKey,
  chromeExpiryToUnix,
  decryptChromeValue,
  exportSoundCloudCookies,
  findGitWorkTree,
  inspectCookieFile,
  jwtClaims,
  pickOAuthToken,
  refreshSoundCloudCookies,
} from "../src/web/cookies.js";
import { webSessionStatus } from "../src/web/doctor.js";
import { extractPlaylistUrn, numericId } from "../src/web/upload.js";

function encryptCookie(value: string, hostKey: string, withHash = true, password = "peanuts"): Buffer {
  const key = pbkdf2Sync(password, "saltysalt", 1, 16, "sha1");
  const plaintext = withHash ? Buffer.concat([createHash("sha256").update(hostKey).digest(), Buffer.from(value, "utf8")]) : Buffer.from(value, "utf8");
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from("v10", "latin1"), cipher.update(plaintext), cipher.final()]);
}

function jwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "at+JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.signature`;
}

test("decryptChromeValue reverses OSCrypt v10 with the host hash prefix", () => {
  const host = "soundcloud.com";
  const token = jwt({ exp: 1_800_000_000, client_id: "client-1" });
  const decrypted = decryptChromeValue(encryptCookie(token, host), chromeCookieKey(), host);
  assert.equal(decrypted, token);
});

test("decryptChromeValue handles values without the SHA-256 host prefix", () => {
  const host = "m.soundcloud.com";
  const value = "short-refresh-token";
  const decrypted = decryptChromeValue(encryptCookie(value, host, false), chromeCookieKey(), host);
  assert.equal(decrypted, value);
});

test("decryptChromeValue rejects app-bound v20 values with a clear error", () => {
  const blob = Buffer.concat([Buffer.from("v20", "latin1"), Buffer.alloc(32)]);
  assert.throws(
    () => decryptChromeValue(blob, chromeCookieKey(), "soundcloud.com"),
    (error: unknown) => error instanceof AppError && /app-bound/.test(error.message)
  );
});

test("chromeExpiryToUnix converts Chrome's 1601 epoch microseconds", () => {
  assert.equal(chromeExpiryToUnix((11_644_473_600 + 1000) * 1_000_000), 1000);
  assert.equal(chromeExpiryToUnix(0), undefined);
  assert.equal(chromeExpiryToUnix(null), undefined);
  assert.equal(chromeExpiryToUnix(13_470_227_398_000_000n), 1_825_753_798);
});

test("jwtClaims reads exp, scope and client_id without verifying the signature", () => {
  const token = jwt({ exp: 1_800_000_000, iat: 1_799_996_400, scope: "upload playcount", client_id: "abc" });
  assert.deepEqual(jwtClaims(token), { exp: 1_800_000_000, iat: 1_799_996_400, scope: "upload playcount", client_id: "abc" });
  assert.equal(jwtClaims("not-a-jwt"), null);
});

test("pickOAuthToken prefers the longest-lived token from several hosts", () => {
  const shortLived = jwt({ exp: 1_000 });
  const longLived = jwt({ exp: 2_000 });
  assert.equal(pickOAuthToken([{ name: "oauth_token", value: shortLived }, { name: "oauth_token", value: longLived }]), longLived);
  assert.equal(pickOAuthToken([]), null);
});

test("inspectCookieFile reports mode, required cookies and token expiry", () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-cookie-test-"));
  const file = join(dir, "cookies.json");
  const exp = Math.floor(Date.now() / 1000) + 3600;
  writeFileSync(
    file,
    JSON.stringify({
      exported_at: new Date().toISOString(),
      cookies: [
        { name: "oauth_token", value: jwt({ exp, client_id: "c" }), domain: "soundcloud.com" },
        { name: "datadome", value: "x", domain: ".soundcloud.com" },
      ],
    })
  );
  chmodSync(file, 0o600);
  const info = inspectCookieFile(file);
  assert.equal(info.exists, true);
  assert.equal(info.mode, "600");
  assert.equal(info.cookies, 2);
  assert.deepEqual(info.missingRequired, ["oauth_refresh_token", "sc_session"]);
  assert.equal(info.expiresInSeconds, exp - Math.floor(Date.now() / 1000));
  assert.equal(info.tokenExpiresAt, new Date(exp * 1000).toISOString());

  const missing = inspectCookieFile(join(dir, "nope.json"));
  assert.equal(missing.exists, false);
  assert.equal(missing.cookies, 0);
});

test("webSessionStatus reports errors for a missing cookie file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sc-doctor-test-"));
  const status = await webSessionStatus({ cookieFile: join(dir, "missing.json"), chromePath: join(dir, "no-chrome") });
  assert.equal(status.ok, false);
  assert.ok(status.errors.some((error) => error.includes("no cookie file")));
  assert.ok(status.errors.some((error) => error.includes("Chrome binary not found")));
  assert.equal(status.session, undefined);
});

test("extractPlaylistUrn walks createAlbumAction results", () => {
  assert.equal(extractPlaylistUrn({ urn: "soundcloud:playlists:42" }), "soundcloud:playlists:42");
  assert.equal(extractPlaylistUrn({ created: [{ playlist: { urn: "soundcloud:playlists:7" } }] }), "soundcloud:playlists:7");
  assert.equal(extractPlaylistUrn({ urn: "soundcloud:tracks:1" }), null);
  assert.equal(extractPlaylistUrn(null), null);
});

test("numericId accepts URNs and bare ids, rejects anything else", () => {
  assert.equal(numericId("soundcloud:tracks:2435416680"), "2435416680");
  assert.equal(numericId("2326955937"), "2326955937");
  assert.equal(numericId("soundcloud:playlists:42/"), "42");
  assert.throws(() => numericId("soundcloud:tracks:abc"), AppError);
});

test("cookie exports refuse to write inside a git work tree", async () => {
  const repo = mkdtempSync(join(tmpdir(), "sc-repo-"));
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(repo, ".git"));
  assert.equal(findGitWorkTree(join(repo, "sub", "cookies.json")), repo);

  assert.equal(findGitWorkTree("/nonexistent-sc-root/out/cookies.json"), null);

  assert.throws(
    () => exportSoundCloudCookies({ outPath: join(repo, "cookies.json") }),
    (error: unknown) => error instanceof AppError && /git repository/.test(error.message)
  );
  await assert.rejects(
    refreshSoundCloudCookies({ cookieFile: join(repo, "cookies.json") }),
    (error: unknown) => error instanceof AppError && /git repository/.test(error.message)
  );
});
