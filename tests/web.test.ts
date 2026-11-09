/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError } from "../src/errors.js";
import { extractChunkPaths, parseServerReferences } from "../src/web/actions.js";
import {
  buildAlbumInput,
  buildTrackInput,
  extractTrackUrn,
  mimeForFile,
  policyHeaders,
  type UploadPolicy,
} from "../src/web/upload.js";

const SAMPLE_CHUNK = `
(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push(["object"==typeof document?document.currentScript:void 0,18582,e=>{
let u=(0,s.createServerReference)("7f7d1b7dcee8df1ad08cf748546c3bbef0ec1ef512",s.callServer,void 0,s.findSourceMapURL,"createUploadPolicyAction");
});
(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push(["object"==typeof document?document.currentScript:void 0,733297,918802,e=>{
let a=(0,w.createServerReference)("7ffaf667a7808b1b7fa363cf16676783066a8a39a5",w.callServer,void 0,w.findSourceMapURL,"createTrackAction");
let b=(0,w.createServerReference)("7ffc4204b5b78e5f7f487b3dc1d6a19207468beb74",w.callServer,void 0,w.findSourceMapURL,"createAlbumAction");
});
`;

test("parseServerReferences extracts live action ids by name", () => {
  const actions = parseServerReferences(SAMPLE_CHUNK);
  assert.equal(actions.get("createUploadPolicyAction"), "7f7d1b7dcee8df1ad08cf748546c3bbef0ec1ef512");
  assert.equal(actions.get("createTrackAction"), "7ffaf667a7808b1b7fa363cf16676783066a8a39a5");
  assert.equal(actions.get("createAlbumAction"), "7ffc4204b5b78e5f7f487b3dc1d6a19207468beb74");
  assert.equal(actions.size, 3);
});

test("extractChunkPaths finds lazy chunk references in loader maps", () => {
  const loaderMap = `,96363,s=>{s.v(t=>Promise.all(["static/chunks/1r0e_o9dhjjf8.js","static/chunks/0hnw388dmkrfb.js"].map(t=>s.l(t))).then(()=>t(18582)))}]);`;
  assert.deepEqual(extractChunkPaths(loaderMap), ["static/chunks/1r0e_o9dhjjf8.js", "static/chunks/0hnw388dmkrfb.js"]);
});

test("policyHeaders mirrors the web client contract", () => {
  const policy: UploadPolicy = {
    url: "https://soundcloud-upload.s3.amazonaws.com/uid.new?X-Amz-Signature=x",
    method: "PUT",
    uid: "uid.new",
    headers: [
      { key: "Host", value: "soundcloud-upload.s3.amazonaws.com" },
      { key: "Content-Length", value: "1234" },
      { key: "Expect", value: "100-continue" },
      { key: "x-amz-acl", value: "private" },
      { key: "x-amz-meta-user-id", value: "985913425" },
      { key: "Content-Disposition", value: "attachment;filename=\"SoundCloud%20Download\"; filename*=utf-8''song.mp3" },
    ],
  };
  const headers = policyHeaders(policy, "audio/mpeg");
  assert.equal(headers["Content-Type"], "audio/mpeg");
  assert.equal(headers["x-amz-acl"], "private");
  assert.equal(headers["x-amz-meta-user-id"], "985913425");
  assert.equal(headers["Content-Disposition"], "attachment;filename=\"SoundCloud%20Download\"; filename*=utf-8''song.mp3");
  assert.equal(headers.Host, undefined);
  assert.equal(headers["Content-Length"], undefined);
  assert.equal(headers.Expect, undefined);
});

test("buildTrackInput matches the payload verified against the live uploader", () => {
  const input = buildTrackInput({
    title: "song",
    originalFilename: "song.mp3",
    artist: "aero",
    durationSeconds: 121.47,
  }) as Record<string, unknown>;
  assert.equal(input.title, "song");
  assert.equal(input.permalink, "");
  assert.equal(input.originalFilename, "song.mp3");
  assert.deepEqual(input.tagList, []);
  assert.equal(input.shareAccess, "PUBLIC");
  assert.equal(input.license, "all-rights-reserved");
  assert.equal(input.firstFansPreEnrollment, "NOT_ENROLLED");
  assert.deepEqual(input.snippetPresets, { startSeconds: 0, endSeconds: 20 });
  const publisher = input.publisherMetadata as Record<string, unknown>;
  assert.equal(publisher.artist, "aero");
  assert.equal(publisher.explicit, false);
  assert.equal(publisher.iswc, null);
});

test("buildTrackInput clamps preview length for short tracks", () => {
  const input = buildTrackInput({ title: "short", originalFilename: "short.mp3", durationSeconds: 3 }) as Record<string, unknown>;
  assert.deepEqual(input.snippetPresets, { startSeconds: 0, endSeconds: 3 });
});

test("buildAlbumInput omits imageData and carries the track urns", () => {
  const payload = buildAlbumInput({ title: "song", trackUrns: ["soundcloud:tracks:123456789"] });
  assert.equal("imageData" in payload, false);
  const playlist = payload.createPlaylist as Record<string, unknown>;
  assert.equal(playlist.title, "song");
  assert.equal(playlist.public, true);
  assert.equal(playlist.setType, "ALBUM");
  assert.equal(playlist.license, "all-rights-reserved");
  assert.deepEqual(playlist.tracks, { urns: ["soundcloud:tracks:123456789"] });
});

test("mimeForFile maps supported audio extensions and rejects the rest", () => {
  assert.equal(mimeForFile("/tmp/song.mp3"), "audio/mpeg");
  assert.equal(mimeForFile("/tmp/song.FLAC"), "audio/flac");
  assert.equal(mimeForFile("/tmp/song.wav"), "audio/wav");
  assert.throws(
    () => mimeForFile("/tmp/song.txt"),
    (error: unknown) => error instanceof AppError && error.code === "UNSUPPORTED_MEDIA"
  );
});

test("extractTrackUrn walks action results", () => {
  assert.equal(extractTrackUrn([{ urn: "soundcloud:tracks:1" }]), "soundcloud:tracks:1");
  assert.equal(extractTrackUrn({ tracks: [{ urn: "soundcloud:tracks:2" }] }), "soundcloud:tracks:2");
  assert.equal(extractTrackUrn({ trackUrn: "soundcloud:tracks:3" }), "soundcloud:tracks:3");
  assert.equal(extractTrackUrn({}), null);
  assert.equal(extractTrackUrn(null), null);
});
