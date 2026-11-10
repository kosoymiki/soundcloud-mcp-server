/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { randomBytes, randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import Busboy from "busboy";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { Store } from "../auth/store.js";
import type { SoundCloudApi } from "../soundcloud/api.js";
import type { UploadService } from "../uploads/service.js";
import type { AudioService } from "../audio/service.js";
import type { EventBus, ServerEvent } from "../events.js";
import { webSessionStatus } from "../web/doctor.js";
import { type Authenticator, type AuthResult, extractBearer, readCookie } from "../http/auth.js";
import { clearPanelCookie, panelCookie } from "../http/cookies.js";
import { pkcePair, randomToken } from "../auth/crypto.js";
import { resolveAppCredentials } from "../auth/appCredentials.js";
import { isLoopbackAddress } from "../auth/oauth.js";
import { AppError, toAppError } from "../errors.js";
import { toUrn } from "../util/ids.js";
import { renderLoginPage, renderPanel, renderSetupPage } from "./ui.js";

export interface PanelDeps {
  config: Config;
  store: Store;
  apiFactory: (connectionId: string) => SoundCloudApi;
  uploads: UploadService;
  audio: AudioService;
  events: EventBus;
  authenticator: Authenticator;
  logger: Logger;
}

const PANEL_COOKIE = "scmcp_panel";

interface UploadedFile {
  path: string;
  filename: string;
  size: number;
}

function nonce(): string {
  return randomBytes(16).toString("base64");
}

function originAllowed(config: Config, req: Request): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || origin.length === 0) return true;
  try {
    return new URL(origin).origin === new URL(config.publicUrl).origin;
  } catch {
    return false;
  }
}

function requireCsrf(req: Request, auth: AuthResult, config: Config): void {
  // Bearer/OAuth headers are not attached by cross-site forms; cookie and
  // loopback auto-login requests need the explicit CSRF header.
  if (auth.kind === "oauth" || auth.kind === "local-token") return;
  if (!originAllowed(config, req)) {
    throw new AppError("FORBIDDEN", "Cross-origin request rejected.", { status: 403 });
  }
  if (req.headers["x-scmcp-csrf"] !== "1") {
    throw new AppError("FORBIDDEN", "Missing x-scmcp-csrf header for cookie-authenticated mutation.", {
      status: 403,
    });
  }
}

function parseUpload(req: Request, config: Config): Promise<{ fields: Record<string, string>; file: UploadedFile }> {
  return new Promise((resolve, reject) => {
    const tmpDir = join(config.dataDir, "uploads");
    mkdirSync(tmpDir, { recursive: true, mode: 0o700 });

    let busboy: Busboy.Busboy;
    try {
      busboy = Busboy({
        headers: req.headers,
        limits: { files: 1, fields: 20, fileSize: config.sc.maxUploadBytes, fieldSize: 64 * 1024 },
      });
    } catch (error) {
      reject(new AppError("BAD_REQUEST", `Invalid multipart body: ${(error as Error).message}`, { status: 400 }));
      return;
    }

    const fields: Record<string, string> = {};
    let file: UploadedFile | null = null;
    let fileStream: ReturnType<typeof createWriteStream> | null = null;
    let truncated = false;
    let settled = false;

    const cleanup = (): void => {
      if (file) {
        try {
          unlinkSync(file.path);
        } catch {
          // Best effort.
        }
      }
    };

    busboy.on("field", (name, value) => {
      fields[name] = value;
    });

    busboy.on("file", (name, stream, info) => {
      if (name !== "file") {
        stream.resume();
        return;
      }
      const safeName = basename(info.filename || "upload.bin").replace(/[^\w.\-]+/g, "_");
      const path = join(tmpDir, `${randomUUID()}-${safeName}`);
      file = { path, filename: safeName, size: 0 };
      fileStream = createWriteStream(path, { mode: 0o600 });
      stream.on("data", (chunk: Buffer) => {
        if (file) file.size += chunk.length;
      });
      stream.on("limit", () => {
        truncated = true;
      });
      stream.pipe(fileStream);
    });

    busboy.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new AppError("BAD_REQUEST", `Upload parse failed: ${error.message}`, { status: 400 }));
    });

    busboy.on("close", () => {
      if (settled) return;
      settled = true;
      if (truncated) {
        cleanup();
        reject(
          new AppError("UPLOAD_TOO_LARGE", `File exceeds ${config.sc.maxUploadBytes} bytes.`, { status: 413 })
        );
        return;
      }
      if (!file) {
        reject(new AppError("BAD_REQUEST", "No file part named `file` in multipart body.", { status: 400 }));
        return;
      }
      const finalFile = file;
      if (fileStream) {
        fileStream.end(() => resolve({ fields, file: finalFile }));
      } else {
        resolve({ fields, file: finalFile });
      }
    });

    req.pipe(busboy);
  });
}

function metadataFromFields(fields: Record<string, string>): Record<string, unknown> {
  let parsed: unknown = {};
  if (fields.metadata) {
    try {
      parsed = JSON.parse(fields.metadata);
    } catch {
      throw new AppError("BAD_REQUEST", "metadata must be valid JSON.", { status: 400 });
    }
  }
  if (!parsed || typeof parsed !== "object") throw new AppError("BAD_REQUEST", "metadata must be an object.", { status: 400 });
  const raw = parsed as Record<string, unknown>;
  const tags = raw.tags;
  return {
    ...(typeof raw.title === "string" && raw.title.trim() ? { title: raw.title.trim() } : {}),
    ...(typeof raw.artist === "string" && raw.artist.trim() ? { artist: raw.artist.trim() } : {}),
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    ...(typeof raw.genre === "string" && raw.genre.trim() ? { genre: raw.genre.trim() } : {}),
    ...(typeof tags === "string" && tags.trim() ? { tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean) } : {}),
    ...(raw.sharing === "public" || raw.sharing === "private" ? { sharing: raw.sharing } : {}),
    ...(typeof raw.downloadable === "boolean" ? { downloadable: raw.downloadable } : {}),
    ...(typeof raw.streamable === "boolean" ? { streamable: raw.streamable } : {}),
    ...(typeof raw.license === "string" ? { license: raw.license } : {}),
  };
}

function parseLimit(value: unknown, fallback: number, max = 200): number {
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

export function createPanelRouter(deps: PanelDeps): Router {
  const { config, store, apiFactory, uploads, audio, events, authenticator, logger } = deps;
  const router = express.Router();
  const json = express.json({ limit: "256kb" });
  const AUTH = Symbol("scmcp.auth");
  type AuthedRequest = Request & { [AUTH]?: AuthResult };

  const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
    const auth = authenticator.authenticate(req);
    if (!auth) {
      res.status(401).json({ error: true, code: "UNAUTHORIZED", message: "Sign in or send a Bearer token." });
      return;
    }
    const connection = store.getConnection(auth.connectionId);
    if (!connection) {
      res.status(401).json({ error: true, code: "NEEDS_REAUTH", message: "SoundCloud connection missing." });
      return;
    }
    (req as AuthedRequest)[AUTH] = auth;
    next();
  };

  const authOf = (req: Request): AuthResult => (req as AuthedRequest)[AUTH] as AuthResult;

  // ── Pages ──────────────────────────────────────────────────────────────────

  router.get("/panel", (req, res) => {
    const auth = authenticator.authenticate(req);
    if (!auth) {
      res.redirect("/panel/login");
      return;
    }
    const nonceValue = nonce();
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; style-src 'nonce-${nonceValue}'; script-src 'nonce-${nonceValue}'; connect-src 'self'; img-src 'self' https: data:; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`
    );
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(renderPanel(config, nonceValue));
  });

  router.get("/panel/login", (req, res) => {
    const hasConnection = store.listConnections().length > 0;
    const hasCredentials = resolveAppCredentials(config, store) !== null;
    const loopback = isLoopbackAddress(req.socket.remoteAddress);
    const errorCode = typeof req.query.error === "string" ? req.query.error : undefined;
    const error =
      errorCode === "missing_client"
        ? "SoundCloud app credentials are not configured on this server."
        : errorCode === "exchange_failed"
          ? "SoundCloud rejected the sign-in. Try again."
          : undefined;
    const nonceValue = nonce();
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; style-src 'nonce-${nonceValue}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`
    );
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(
      renderLoginPage(config, nonceValue, {
        canConnect: hasCredentials,
        hasConnection,
        showSetup: loopback && !hasCredentials,
        ...(error ? { error } : {}),
      })
    );
  });

  router.get("/panel/setup", (req, res) => {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      res.status(403).type("text/plain").send("Device setup is available only from loopback.");
      return;
    }
    const nonceValue = nonce();
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; style-src 'nonce-${nonceValue}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`
    );
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(renderSetupPage(config, nonceValue));
  });

  router.post("/panel/setup", express.urlencoded({ extended: false, limit: "16kb" }), (req, res) => {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      res.status(403).type("text/plain").send("Device setup is available only from loopback.");
      return;
    }
    const clientId = typeof req.body?.client_id === "string" ? req.body.client_id.trim() : "";
    const clientSecret = typeof req.body?.client_secret === "string" ? req.body.client_secret.trim() : "";
    if (clientId.length < 8 || clientSecret.length < 8 || clientId.length > 300 || clientSecret.length > 300) {
      const nonceValue = nonce();
      res.status(400).setHeader(
        "Content-Security-Policy",
        `default-src 'none'; style-src 'nonce-${nonceValue}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`
      );
      res.type("html").send(renderSetupPage(config, nonceValue, "Client ID and secret look invalid."));
      return;
    }
    store.setAppCredentials({ clientId, clientSecret });
    logger.info("SoundCloud app credentials stored (encrypted)");
    res.redirect("/panel/auth/start");
  });

  /**
   * Browser sign-in: starts a PKCE flow against SoundCloud and returns to
   * /soundcloud/callback, which stores the connection and sets an HttpOnly
   * session cookie. No token is ever copied by the user.
   */
  router.get("/panel/auth/start", (_req, res) => {
    const credentials = resolveAppCredentials(config, store);
    if (!credentials) {
      res.redirect("/panel/setup");
      return;
    }
    const scClientId = credentials.clientId;
    const scClientSecret = credentials.clientSecret;

    const pkce = pkcePair();
    const state = randomToken(24);
    store.storeLoginState(state, {
      kind: "panel",
      scClientId,
      scClientSecret,
      codeVerifier: pkce.verifier,
    });

    const params = new URLSearchParams({
      client_id: scClientId,
      redirect_uri: config.sc.redirectUri,
      response_type: "code",
      state,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
    });
    const scope = process.env.SC_SCOPE?.trim();
    if (scope) params.set("scope", scope);
    res.redirect(`${config.sc.authorizeUrl}?${params.toString()}`);
  });

  router.post("/panel/logout", (req, res) => {
    const auth = authenticator.authenticate(req);
    if (auth) {
      try {
        requireCsrf(req, auth, config);
      } catch {
        res.status(403).json({ error: true, code: "FORBIDDEN", message: "CSRF check failed." });
        return;
      }
    }
    const token = extractBearer(req) ?? readCookie(req, PANEL_COOKIE);
    if (token && token !== config.security.localToken) store.revokeToken(token);
    res.setHeader("Set-Cookie", clearPanelCookie());
    res.json({ ok: true });
  });

  // ── State ─────────────────────────────────────────────────────────────────

  router.get("/api/web/status", requireAuth, async (_req, res, next) => {
    try {
      res.json(await webSessionStatus({ probe: false }));
    } catch (error) {
      next(toAppError(error));
    }
  });

  router.get("/api/state", requireAuth, async (req, res, next) => {
    try {
      const api = apiFactory(authOf(req).connectionId);
      const errors: Record<string, string> = {};
      const settle = async <T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
        try {
          return await fn();
        } catch (error) {
          errors[name] = error instanceof Error ? error.message : String(error);
          return fallback;
        }
      };

      const me = await api.me();
      const [quota, tracks, playlists, likes, followers, followings] = await Promise.all([
        settle("quota", () => api.quota(), { unlimited: false, secondsUsed: null, secondsLeft: null }),
        settle("tracks", () => api.myTracks({ limit: 50, maxItems: 50 }), { items: [], next: null }),
        settle("playlists", () => api.myPlaylists({ limit: 50, maxItems: 50 }), { items: [], next: null }),
        settle("likes", () => api.myLikes({ limit: 20, maxItems: 20 }), { items: [], next: null }),
        settle("followers", () => api.myFollowers({ limit: 20, maxItems: 20 }), { items: [], next: null }),
        settle("followings", () => api.myFollowings({ limit: 20, maxItems: 20 }), { items: [], next: null }),
      ]);

      res.json({
        me,
        quota,
        tracks,
        playlists,
        likes,
        followers,
        followings,
        errors,
        mode: config.mode,
        version: config.version,
        limits: { maxUploadBytes: config.sc.maxUploadBytes, mediaRoots: config.mediaRoots },
      });
    } catch (error) {
      next(toAppError(error));
    }
  });

  router.get("/api/tracks", requireAuth, async (req, res, next) => {
    try {
      const api = apiFactory(authOf(req).connectionId);
      const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
      const page = await api.myTracks({
        limit: parseLimit(req.query.limit, 50),
        maxItems: parseLimit(req.query.max_items, 50, 2000),
        ...(cursor ? { cursor } : {}),
      });
      res.json(page);
    } catch (error) {
      next(toAppError(error));
    }
  });

  router.get("/api/playlists", requireAuth, async (req, res, next) => {
    try {
      const api = apiFactory(authOf(req).connectionId);
      res.json(
        await api.myPlaylists({
          limit: parseLimit(req.query.limit, 50),
          maxItems: parseLimit(req.query.max_items, 50, 2000),
        })
      );
    } catch (error) {
      next(toAppError(error));
    }
  });

  router.get("/api/playlists/:urn", requireAuth, async (req, res, next) => {
    try {
      const api = apiFactory(authOf(req).connectionId);
      res.json(await api.playlist(toUrn("playlists", req.params.urn as string)));
    } catch (error) {
      next(toAppError(error));
    }
  });

  router.get("/api/tracks/:urn/comments", requireAuth, async (req, res, next) => {
    try {
      const api = apiFactory(authOf(req).connectionId);
      res.json(
        await api.comments(toUrn("tracks", req.params.urn as string), {
          limit: parseLimit(req.query.limit, 50),
        })
      );
    } catch (error) {
      next(toAppError(error));
    }
  });

  // ── Profile ───────────────────────────────────────────────────────────────

  router.post("/api/profile", requireAuth, json, async (req, res, next) => {
    try {
      requireCsrf(req, authOf(req), config);
      const api = apiFactory(authOf(req).connectionId);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const allowed = [
        "username",
        "first_name",
        "last_name",
        "full_name",
        "description",
        "city",
        "country",
        "website",
        "website_title",
        "discogs_name",
      ];
      const fields: Record<string, string> = {};
      for (const key of allowed) {
        const value = body[key];
        if (typeof value === "string" && value.trim().length > 0) fields[key] = value.trim().slice(0, 4000);
      }
      res.json(await api.updateProfile(fields));
    } catch (error) {
      next(toAppError(error));
    }
  });

  router.post("/api/profile/avatar", requireAuth, async (req, res, next) => {
    let uploaded: UploadedFile | null = null;
    try {
      requireCsrf(req, authOf(req), config);
      const parsed = await parseUpload(req, config);
      uploaded = parsed.file;
      const api = apiFactory(authOf(req).connectionId);
      res.json(await api.uploadAvatar(parsed.file.path));
    } catch (error) {
      next(toAppError(error));
    } finally {
      if (uploaded) {
        try {
          unlinkSync(uploaded.path);
        } catch {
          // Best effort.
        }
      }
    }
  });

  // ── Upload ────────────────────────────────────────────────────────────────

  router.post("/api/upload", requireAuth, async (req, res, next) => {
    let uploaded: UploadedFile | null = null;
    try {
      requireCsrf(req, authOf(req), config);
      const parsed = await parseUpload(req, config);
      uploaded = parsed.file;
      const metadata = metadataFromFields(parsed.fields);
      const uploadId = parsed.fields.upload_id || `api_${randomUUID()}`;
      const api = apiFactory(authOf(req).connectionId);

      const result = await uploads.withApi(api).upload({
        filePath: parsed.file.path,
        fileName: parsed.file.filename,
        metadata: metadata as never,
        autoTag: parsed.fields.auto_tag !== "false",
        attachArtwork: parsed.fields.attach_artwork !== "false",
        uploadId,
      });
      res.status(201).json(result);
    } catch (error) {
      next(toAppError(error));
    } finally {
      if (uploaded) {
        try {
          unlinkSync(uploaded.path);
        } catch {
          // Best effort.
        }
      }
    }
  });

  // ── Tracks ────────────────────────────────────────────────────────────────

  router.patch("/api/tracks/:urn", requireAuth, json, async (req, res, next) => {
    try {
      requireCsrf(req, authOf(req), config);
      const api = apiFactory(authOf(req).connectionId);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const track = await api.updateTrack(toUrn("tracks", req.params.urn as string), {
        ...(typeof body.title === "string" ? { title: body.title } : {}),
        ...(typeof body.description === "string" ? { description: body.description } : {}),
        ...(typeof body.genre === "string" ? { genre: body.genre } : {}),
        ...(typeof body.tags === "string" || Array.isArray(body.tags) ? { tags: body.tags as string | string[] } : {}),
        ...(body.sharing === "public" || body.sharing === "private" ? { sharing: body.sharing } : {}),
        ...(typeof body.downloadable === "boolean" ? { downloadable: body.downloadable } : {}),
        ...(typeof body.streamable === "boolean" ? { streamable: body.streamable } : {}),
        ...(typeof body.commentable === "boolean" ? { commentable: body.commentable } : {}),
        ...(typeof body.permalink === "string" ? { permalink: body.permalink } : {}),
        ...(typeof body.label_name === "string" ? { labelName: body.label_name } : {}),
        ...(typeof body.release_date === "string" ? { releaseDate: body.release_date } : {}),
        ...(typeof body.isrc === "string" ? { isrc: body.isrc } : {}),
        ...(typeof body.metadata_artist === "string" ? { metadataArtist: body.metadata_artist } : {}),
        ...(typeof body.purchase_url === "string" ? { purchaseUrl: body.purchase_url } : {}),
        ...(typeof body.purchase_title === "string" ? { purchaseTitle: body.purchase_title } : {}),
        ...(typeof body.license === "string" ? { license: body.license as never } : {}),
        ...(body.embeddable_by === "all" || body.embeddable_by === "me" || body.embeddable_by === "none"
          ? { embeddableBy: body.embeddable_by }
          : {}),
        ...(typeof body.reveal_stats === "boolean" ? { revealStats: body.reveal_stats } : {}),
        ...(typeof body.reveal_comments === "boolean" ? { revealComments: body.reveal_comments } : {}),
      });
      res.json(track);
    } catch (error) {
      next(toAppError(error));
    }
  });

  router.delete("/api/tracks/:urn", requireAuth, async (req, res, next) => {
    try {
      requireCsrf(req, authOf(req), config);
      const api = apiFactory(authOf(req).connectionId);
      await api.deleteTrack(toUrn("tracks", req.params.urn as string));
      res.json({ ok: true });
    } catch (error) {
      next(toAppError(error));
    }
  });

  router.put("/api/tracks/:urn/artwork", requireAuth, async (req, res, next) => {
    let uploaded: UploadedFile | null = null;
    try {
      requireCsrf(req, authOf(req), config);
      const parsed = await parseUpload(req, config);
      uploaded = parsed.file;
      const api = apiFactory(authOf(req).connectionId);
      const { makeFilePart } = await import("../soundcloud/multipart.js");
      res.json(await api.uploadArtwork(toUrn("tracks", req.params.urn as string), makeFilePart(parsed.file.path)));
    } catch (error) {
      next(toAppError(error));
    } finally {
      if (uploaded) {
        try {
          unlinkSync(uploaded.path);
        } catch {
          // Best effort.
        }
      }
    }
  });

  // ── Audio lab ─────────────────────────────────────────────────────────────

  /** Saves a browser-selected file into the server's staging area for editing. */
  router.post("/api/audio/stage", requireAuth, async (req, res, next) => {
    try {
      requireCsrf(req, authOf(req), config);
      const parsed = await parseUpload(req, config);
      res.status(201).json({
        file_path: parsed.file.path,
        filename: parsed.file.filename,
        size: parsed.file.size,
        note: "Staged under DATA_DIR/uploads; edit it, then upload the result.",
      });
    } catch (error) {
      next(toAppError(error));
    }
  });

  router.post("/api/audio/probe", requireAuth, json, async (req, res, next) => {
    try {
      requireCsrf(req, authOf(req), config);
      const body = (req.body ?? {}) as { file_path?: unknown };
      if (typeof body.file_path !== "string" || body.file_path.length === 0) {
        throw new AppError("BAD_REQUEST", "file_path is required.", { status: 400 });
      }
      res.json(await audio.probe(body.file_path));
    } catch (error) {
      next(toAppError(error));
    }
  });

  router.post("/api/audio/tags", requireAuth, json, async (req, res, next) => {
    try {
      requireCsrf(req, authOf(req), config);
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.file_path !== "string") throw new AppError("BAD_REQUEST", "file_path is required.", { status: 400 });
      const tags = (body.tags ?? {}) as Record<string, unknown>;
      const edits = {
        title: typeof tags.title === "string" ? tags.title : undefined,
        artist: typeof tags.artist === "string" ? tags.artist : undefined,
        album: typeof tags.album === "string" ? tags.album : undefined,
        albumArtist: typeof tags.album_artist === "string" ? tags.album_artist : undefined,
        genre: typeof tags.genre === "string" ? tags.genre : undefined,
        year: typeof tags.year === "string" ? tags.year : undefined,
        track: typeof tags.track === "string" ? tags.track : undefined,
        disc: typeof tags.disc === "string" ? tags.disc : undefined,
        comment: typeof tags.comment === "string" ? tags.comment : undefined,
        composer: typeof tags.composer === "string" ? tags.composer : undefined,
        bpm: typeof tags.bpm === "string" ? tags.bpm : undefined,
        isrc: typeof tags.isrc === "string" ? tags.isrc : undefined,
        lyrics: typeof tags.lyrics === "string" ? tags.lyrics : undefined,
        copyright: typeof tags.copyright === "string" ? tags.copyright : undefined,
        publisher: typeof tags.publisher === "string" ? tags.publisher : undefined,
        encodedBy: typeof tags.encoded_by === "string" ? tags.encoded_by : undefined,
      };
      res.json(
        await audio.updateTags({
          filePath: body.file_path,
          edits,
          ...(typeof body.artwork_path === "string" ? { artworkPath: body.artwork_path } : {}),
          ...(body.remove_artwork === true ? { removeArtwork: true } : {}),
          ...(typeof body.output_path === "string" ? { outputPath: body.output_path } : {}),
          backup: body.backup !== false,
        })
      );
    } catch (error) {
      next(toAppError(error));
    }
  });

  router.post("/api/audio/artwork", requireAuth, async (req, res, next) => {
    let uploaded: UploadedFile | null = null;
    try {
      requireCsrf(req, authOf(req), config);
      const parsed = await parseUpload(req, config);
      uploaded = parsed.file;
      const filePath = parsed.fields.file_path;
      if (!filePath) throw new AppError("BAD_REQUEST", "file_path field is required.", { status: 400 });
      res.json(
        await audio.updateTags({
          filePath,
          edits: {},
          artworkPath: parsed.file.path,
          backup: parsed.fields.backup !== "false",
          ...(parsed.fields.output_path ? { outputPath: parsed.fields.output_path } : {}),
        })
      );
    } catch (error) {
      next(toAppError(error));
    } finally {
      if (uploaded) {
        try {
          unlinkSync(uploaded.path);
        } catch {
          // Best effort.
        }
      }
    }
  });

  router.post("/api/audio/process", requireAuth, json, async (req, res, next) => {
    try {
      requireCsrf(req, authOf(req), config);
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.file_path !== "string") throw new AppError("BAD_REQUEST", "file_path is required.", { status: 400 });
      const operation = body.operation;
      if (
        operation !== "tempo" &&
        operation !== "pitch" &&
        operation !== "speed" &&
        operation !== "both" &&
        operation !== "normalize" &&
        operation !== "trim" &&
        operation !== "convert"
      ) {
        throw new AppError("BAD_REQUEST", "operation must be tempo, pitch, speed, both, normalize, trim or convert.", {
          status: 400,
        });
      }
      res.json(
        await audio.process({
          filePath: body.file_path,
          operation,
          ...(typeof body.ratio === "number" ? { ratio: body.ratio } : {}),
          ...(typeof body.pitch === "number" ? { pitch: body.pitch } : {}),
          ...(typeof body.algorithm === "string" ? { algorithm: body.algorithm as never } : {}),
          ...(typeof body.target_lufs === "number" ? { targetLufs: body.target_lufs } : {}),
          ...(typeof body.true_peak === "number" ? { truePeak: body.true_peak } : {}),
          ...(typeof body.lra === "number" ? { lra: body.lra } : {}),
          ...(typeof body.start_seconds === "number" ? { startSeconds: body.start_seconds } : {}),
          ...(typeof body.end_seconds === "number" ? { endSeconds: body.end_seconds } : {}),
          ...(body.format === "mp3" || body.format === "wav" || body.format === "flac" ? { format: body.format } : {}),
          ...(typeof body.bitrate_kbps === "number" ? { bitrateKbps: body.bitrate_kbps } : {}),
          ...(typeof body.output_path === "string" ? { outputPath: body.output_path } : {}),
          overwrite: body.overwrite === true,
          keepTags: body.keep_tags !== false,
        })
      );
    } catch (error) {
      next(toAppError(error));
    }
  });

  router.post("/api/audio/upload", requireAuth, json, async (req, res, next) => {
    try {
      requireCsrf(req, authOf(req), config);
      const body = (req.body ?? {}) as { file_path?: unknown; metadata?: unknown };
      if (typeof body.file_path !== "string") throw new AppError("BAD_REQUEST", "file_path is required.", { status: 400 });
      const api = apiFactory(authOf(req).connectionId);
      const metadata = (body.metadata && typeof body.metadata === "object" ? body.metadata : {}) as Record<string, unknown>;
      const result = await uploads.withApi(api).upload({
        filePath: body.file_path,
        metadata: metadata as never,
      });
      res.status(201).json(result);
    } catch (error) {
      next(toAppError(error));
    }
  });

  // ── Playlists ─────────────────────────────────────────────────────────────

  router.post("/api/playlists", requireAuth, json, async (req, res, next) => {
    try {
      requireCsrf(req, authOf(req), config);
      const api = apiFactory(authOf(req).connectionId);
      const body = (req.body ?? {}) as Record<string, unknown>;
      res.status(201).json(
        await api.createPlaylist({
          title: typeof body.title === "string" ? body.title : "",
          ...(typeof body.description === "string" ? { description: body.description } : {}),
          ...(body.sharing === "public" || body.sharing === "private" ? { sharing: body.sharing } : {}),
          ...(typeof body.genre === "string" ? { genre: body.genre } : {}),
          ...(typeof body.tags === "string" ? { tags: body.tags } : {}),
        })
      );
    } catch (error) {
      next(toAppError(error));
    }
  });

  router.patch("/api/playlists/:urn", requireAuth, json, async (req, res, next) => {
    try {
      requireCsrf(req, authOf(req), config);
      const api = apiFactory(authOf(req).connectionId);
      const body = (req.body ?? {}) as Record<string, unknown>;
      res.json(
        await api.updatePlaylist(toUrn("playlists", req.params.urn as string), {
          ...(typeof body.title === "string" ? { title: body.title } : {}),
          ...(typeof body.description === "string" ? { description: body.description } : {}),
          ...(body.sharing === "public" || body.sharing === "private" ? { sharing: body.sharing } : {}),
          ...(typeof body.genre === "string" ? { genre: body.genre } : {}),
          ...(typeof body.tags === "string" || Array.isArray(body.tags) ? { tags: body.tags as string | string[] } : {}),
          ...(typeof body.label_name === "string" ? { labelName: body.label_name } : {}),
          ...(typeof body.release_date === "string" ? { releaseDate: body.release_date } : {}),
          ...(typeof body.permalink === "string" ? { permalink: body.permalink } : {}),
          ...(typeof body.purchase_url === "string" ? { purchaseUrl: body.purchase_url } : {}),
          ...(typeof body.purchase_title === "string" ? { purchaseTitle: body.purchase_title } : {}),
          ...(body.set_type === "album" || body.set_type === "playlist" ? { setType: body.set_type } : {}),
          ...(typeof body.ean === "string" ? { ean: body.ean } : {}),
          ...(typeof body.license === "string" ? { license: body.license } : {}),
        })
      );
    } catch (error) {
      next(toAppError(error));
    }
  });

  router.delete("/api/playlists/:urn", requireAuth, async (req, res, next) => {
    try {
      requireCsrf(req, authOf(req), config);
      const api = apiFactory(authOf(req).connectionId);
      await api.deletePlaylist(toUrn("playlists", req.params.urn as string));
      res.json({ ok: true });
    } catch (error) {
      next(toAppError(error));
    }
  });

  /**
   * Playlist/album artwork. The public OpenAPI only documents artwork_data on
   * POST /playlists, but the API is commonly observed to accept a multipart PUT
   * as well. The attempt is explicit: if SoundCloud rejects it, the caller gets
   * the real HTTP error instead of a silent no-op.
   */
  router.post("/api/playlists/:urn/artwork", requireAuth, async (req, res, next) => {
    let uploaded: UploadedFile | null = null;
    try {
      requireCsrf(req, authOf(req), config);
      const parsed = await parseUpload(req, config);
      uploaded = parsed.file;
      const api = apiFactory(authOf(req).connectionId);
      const { makeFilePart } = await import("../soundcloud/multipart.js");
      res.json(
        await api.uploadPlaylistArtwork(
          toUrn("playlists", req.params.urn as string),
          makeFilePart(parsed.file.path)
        )
      );
    } catch (error) {
      next(toAppError(error));
    } finally {
      if (uploaded) {
        try {
          unlinkSync(uploaded.path);
        } catch {
          // Best effort.
        }
      }
    }
  });

  router.post("/api/playlists/:urn/tracks", requireAuth, json, async (req, res, next) => {
    try {
      requireCsrf(req, authOf(req), config);
      const api = apiFactory(authOf(req).connectionId);
      const urn = toUrn("playlists", req.params.urn as string);
      const body = (req.body ?? {}) as { add?: unknown; remove?: unknown; order?: unknown };
      const toUrns = (value: unknown): string[] => {
        if (!Array.isArray(value)) return [];
        return value.map((entry) => toUrn("tracks", entry as string | number));
      };

      if (Array.isArray(body.order)) {
        res.json(await api.reorderPlaylist(urn, toUrns(body.order)));
        return;
      }
      if (Array.isArray(body.add) && body.add.length > 0) {
        res.json(await api.addTracks(urn, toUrns(body.add)));
        return;
      }
      if (Array.isArray(body.remove) && body.remove.length > 0) {
        const remove = body.remove.map((entry) => toUrn("tracks", entry as string | number));
        let playlist = await api.playlist(urn);
        for (const track of remove) {
          playlist = await api.removeTrack(urn, track);
        }
        res.json(playlist);
        return;
      }
      throw new AppError("BAD_REQUEST", "Provide `add`, `remove` or `order`.", { status: 400 });
    } catch (error) {
      next(toAppError(error));
    }
  });

  // ── Social ────────────────────────────────────────────────────────────────

  router.post("/api/social/like", requireAuth, json, async (req, res, next) => {
    try {
      requireCsrf(req, authOf(req), config);
      const api = apiFactory(authOf(req).connectionId);
      const body = (req.body ?? {}) as { kind?: unknown; urn?: unknown; action?: unknown };
      const kind = body.kind === "playlist" ? "playlists" : "tracks";
      const urn = toUrn(kind, body.urn as string);
      if (body.action === "unlike") {
        if (kind === "tracks") await api.unlikeTrack(urn);
        else await api.unlikePlaylist(urn);
      } else {
        if (kind === "tracks") await api.likeTrack(urn);
        else await api.likePlaylist(urn);
      }
      res.json({ ok: true, kind, urn, action: body.action === "unlike" ? "unliked" : "liked" });
    } catch (error) {
      next(toAppError(error));
    }
  });

  router.post("/api/social/repost", requireAuth, json, async (req, res, next) => {
    try {
      requireCsrf(req, authOf(req), config);
      const api = apiFactory(authOf(req).connectionId);
      const body = (req.body ?? {}) as { urn?: unknown; action?: unknown };
      const urn = toUrn("tracks", body.urn as string);
      if (body.action === "unrepost") await api.unrepostTrack(urn);
      else await api.repostTrack(urn);
      res.json({ ok: true, urn, action: body.action === "unrepost" ? "unreposted" : "reposted" });
    } catch (error) {
      next(toAppError(error));
    }
  });

  router.post("/api/social/follow", requireAuth, json, async (req, res, next) => {
    try {
      requireCsrf(req, authOf(req), config);
      const api = apiFactory(authOf(req).connectionId);
      const body = (req.body ?? {}) as { urn?: unknown; action?: unknown };
      const urn = toUrn("users", body.urn as string);
      if (body.action === "unfollow") await api.unfollow(urn);
      else await api.follow(urn);
      res.json({ ok: true, urn, action: body.action === "unfollow" ? "unfollowed" : "followed" });
    } catch (error) {
      next(toAppError(error));
    }
  });

  // ── Export & events ───────────────────────────────────────────────────────

  router.get("/api/export", requireAuth, async (req, res, next) => {
    try {
      const api = apiFactory(authOf(req).connectionId);
      const [me, tracks, playlists] = await Promise.all([
        api.me(),
        api.myTracks({ maxItems: 1000 }),
        api.myPlaylists({ maxItems: 500 }),
      ]);
      res.setHeader("Content-Disposition", `attachment; filename="soundcloud-export-${Date.now()}.json"`);
      res.json({ exported_at: new Date().toISOString(), me, tracks, playlists });
    } catch (error) {
      next(toAppError(error));
    }
  });

  router.get("/api/events", requireAuth, (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 3000\n\n");
    const send = (event: ServerEvent): void => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribe = events.subscribe(send);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 20_000);
    heartbeat.unref();
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  });

  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const appError = toAppError(error);
    logger.warn("Panel API error", { code: appError.code, status: appError.options.status, message: appError.message });
    res.status(appError.options.status ?? 500).json(appError.toJSON());
  });

  return router;
}
