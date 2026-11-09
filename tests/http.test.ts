/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpClient } from "../src/soundcloud/http.js";
import { createMultipart, makeFilePart } from "../src/soundcloud/multipart.js";
import { parseStreamExpiry } from "../src/soundcloud/api.js";
import { createLogger } from "../src/logger.js";
import { AppError } from "../src/errors.js";
import { testConfig } from "./helpers.js";

function makeClient(fetchImpl: typeof fetch, token: () => string = () => "initial-token") {
  const config = testConfig();
  return new HttpClient({
    config,
    logger: createLogger("error"),
    getAccessToken: async () => token(),
    fetchImpl,
  });
}

test("request sends OAuth scheme, query and accept header", async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const client = makeClient((async (url: URL | RequestInfo, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch);

  const result = await client.request<{ ok: boolean }>("/tracks", { query: { q: "hi", limit: 5 } });
  assert.deepEqual(result, { ok: true });
  assert.equal(seen.length, 1);
  const headers = seen[0]?.init.headers as Record<string, string>;
  assert.equal(headers.authorization, "OAuth initial-token");
  assert.match(seen[0]?.url ?? "", /\/tracks\?q=hi&limit=5$/);
});

test("401 forces a refresh and retries once with the new token", async () => {
  const auths: string[] = [];
  let forceRefreshed = false;
  const config = testConfig();
  const client = new HttpClient({
    config,
    logger: createLogger("error"),
    getAccessToken: async (options) => {
      if (options?.forceRefresh) {
        forceRefreshed = true;
        return "fresh-token";
      }
      return forceRefreshed ? "fresh-token" : "stale-token";
    },
    fetchImpl: (async (_url, init) => {
      auths.push((init?.headers as Record<string, string>).authorization as string);
      if (auths.length === 1) return new Response("unauthorized", { status: 401 });
      return new Response(JSON.stringify({ id: 1 }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });

  const result = await client.request<{ id: number }>("/me");
  assert.equal(result.id, 1);
  assert.deepEqual(auths, ["OAuth stale-token", "OAuth fresh-token"]);
});

test("429 honours Retry-After and retries", async () => {
  let calls = 0;
  const client = makeClient((async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ message: "slow down" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "0" },
      });
    }
    return new Response(JSON.stringify({ collection: [] }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);

  const result = await client.request<{ collection: unknown[] }>("/tracks");
  assert.deepEqual(result, { collection: [] });
  assert.equal(calls, 2);
});

test("maps HTTP statuses to typed error codes", async () => {
  for (const [status, code] of [
    [403, "FORBIDDEN"],
    [404, "NOT_FOUND"],
    [409, "CONFLICT"],
    [413, "UPLOAD_TOO_LARGE"],
  ] as const) {
    const client = makeClient((async () =>
      new Response(JSON.stringify({ message: "x" }), {
        status,
        headers: { "content-type": "application/json" },
      })) as typeof fetch);
    await assert.rejects(
      () => client.request("/x"),
      (error: unknown) => error instanceof AppError && error.code === code
    );
  }
});

test("pagination follows next_href, caps maxItems and refuses foreign hosts", async () => {
  const urls: string[] = [];
  const client = makeClient((async (url) => {
    urls.push(String(url));
    const isFirst = urls.length === 1;
    return new Response(
      JSON.stringify({
        collection: isFirst ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }, { id: 4 }],
        next_href: isFirst ? "https://api.soundcloud.com/tracks?cursor=abc" : null,
      }),
      { headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch);

  const page = await client.paginate<{ id: number }>("/tracks", { maxItems: 3, pageSize: 2 });
  assert.deepEqual(page.items.map((item) => item.id), [1, 2, 3, 4]);
  assert.equal(page.next, null);
  assert.equal(urls.length, 2);
  assert.match(urls[0] ?? "", /linked_partitioning=1/);

  await assert.rejects(
    () => client.request("https://evil.example/steal"),
    (error: unknown) => error instanceof AppError && error.code === "BAD_REQUEST"
  );
});

test("multipart body has exact Content-Length and streamed file bytes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scmcp-multipart-"));
  const path = join(dir, "track.mp3");
  const fileBytes = Buffer.from(Array.from({ length: 256 * 1024 }, (_, index) => index % 251));
  writeFileSync(path, fileBytes);

  const part = makeFilePart(path);
  const multipart = createMultipart(
    { "track[title]": "My Track", "track[sharing]": "private", skip: undefined },
    part,
    "track[asset_data]"
  );

  const reader = multipart.body.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  assert.equal(bytes.length, multipart.contentLength);
  const text = bytes.toString("latin1");
  assert.match(multipart.contentType, /^multipart\/form-data; boundary=----scmcp/);
  assert.ok(text.includes('name="track[title]"'));
  assert.ok(text.includes("My Track"));
  assert.ok(!text.includes('name="skip"'));
  assert.ok(text.includes('filename="track.mp3"'));
  assert.ok(bytes.includes(fileBytes));
});

test("stream expiry is parsed from Policy and X-Amz parameters", () => {
  const policy = Buffer.from(
    JSON.stringify({ Statement: [{ Condition: { DateLessThan: { epochTime: 1_800_000_000 } } }] })
  ).toString("base64");
  assert.equal(
    parseStreamExpiry(`https://cf-media.sndcdn.com/x.128.mp3?Policy=${encodeURIComponent(policy)}`),
    1_800_000_000_000
  );
  assert.equal(parseStreamExpiry("https://x/y.mp3?Expires=1800000000"), 1_800_000_000_000);
  assert.equal(parseStreamExpiry("https://x/y.mp3?X-Amz-Date=20260101T000000Z&X-Amz-Expires=3600"), Date.UTC(2026, 0, 1, 1, 0, 0));
  assert.equal(parseStreamExpiry("https://x/y.mp3"), null);
});
