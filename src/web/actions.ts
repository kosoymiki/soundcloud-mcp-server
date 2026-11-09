/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { AppError } from "../errors.js";

const DEFAULT_UPLOAD_URL = "https://soundcloud.com/n/upload";
const DEFAULT_CHROME = "chromium-browser";
const ASSET_BASE = "https://assets.web.soundcloud.cloud/_next/";
const INJECT_MODULE_ID = 990003;
const INJECT_CHUNK_PATH = "/_next/static/chunks/__sc_inject.js";

export interface CookieEntry {
  name: string;
  value: string;
  domain: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
}

export interface WebSessionOptions {
  chromePath?: string;
  cookieFile?: string;
  uploadUrl?: string;
  debugPort?: number;
  headless?: boolean;
  userAgent?: string;
  timeoutMs?: number;
  chromeFlags?: string[];
  logger?: (level: "debug" | "info" | "warn", message: string) => void;
}

export interface DiscoveredActions {
  actions: Map<string, string>;
  chunkCount: number;
}

/** Parse `createServerReference("<id>", ..., "<name>")` pairs out of a Turbopack chunk. */
export function parseServerReferences(source: string): Map<string, string> {
  const found = new Map<string, string>();
  const pattern = /createServerReference\)?\("([0-9a-f]{40,44})"[^)]{0,240}?"([A-Za-z0-9_$]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const id = match[1];
    const name = match[2];
    if (id && name) found.set(name, id);
  }
  return found;
}

/** Collect `"static/chunks/<file>.js"` references from a loader-map chunk. */
export function extractChunkPaths(source: string): string[] {
  const paths = new Set<string>();
  const pattern = /["']static\/chunks\/([A-Za-z0-9_.\-]+\.js)["']/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const name = match[1];
    if (name) paths.add(`static/chunks/${name}`);
  }
  return [...paths];
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Drives a logged-in SoundCloud web session over the Chrome DevTools Protocol.
 *
 * SoundCloud's Next.js uploader exposes its upload primitives as private server
 * actions whose ids change with every deployment. The ids are only reachable
 * from the live client bundle, so this class loads the real upload page, reads
 * the chunk graph the page itself loaded, and calls the actions through the
 * app's own `callServer` runtime (injected as an extra Turbopack module).
 */
export class WebActionSession {
  private readonly options: Required<Omit<WebSessionOptions, "logger">> & { logger?: WebSessionOptions["logger"] };
  private browser: Browser | null = null;
  private page: Page | null = null;
  private userDataDir: string | null = null;
  private chromeProcess: ChildProcess | null = null;
  private launchedHere = false;
  private actions = new Map<string, string>();
  private chunkCount = 0;

  constructor(options: WebSessionOptions = {}) {
    this.options = {
      chromePath: options.chromePath ?? process.env.SC_WEB_CHROME ?? DEFAULT_CHROME,
      cookieFile: options.cookieFile ?? process.env.SC_WEB_COOKIE_FILE ?? join(homedir(), ".local", "share", "soundcloud-mcp", "chrome-soundcloud-cookies.json"),
      uploadUrl: options.uploadUrl ?? process.env.SC_WEB_UPLOAD_URL ?? DEFAULT_UPLOAD_URL,
      debugPort: options.debugPort ?? Number(process.env.SC_WEB_DEBUG_PORT ?? 9333),
      headless: options.headless ?? (process.env.SC_WEB_HEADLESS ?? "true") !== "false",
      userAgent:
        options.userAgent ??
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
      timeoutMs: options.timeoutMs ?? Number(process.env.SC_WEB_TIMEOUT_MS ?? 90_000),
      chromeFlags: options.chromeFlags ?? [],
      ...(options.logger ? { logger: options.logger } : {}),
    };
  }

  get actionMap(): ReadonlyMap<string, string> {
    return this.actions;
  }

  get pageHandle(): Page {
    if (!this.page) throw new AppError("INTERNAL", "Web session is not started.", { status: 500 });
    return this.page;
  }

  private log(level: "debug" | "info" | "warn", message: string): void {
    this.options.logger?.(level, message);
  }

  async start(): Promise<void> {
    if (this.page) return;
    const { chromePath, debugPort, headless, uploadUrl, cookieFile, timeoutMs } = this.options;
    const existing = await this.probeCdp(debugPort).catch(() => false);
    if (existing) {
      this.browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${debugPort}` });
    } else {
      this.userDataDir = mkdtempSync(join(tmpdir(), "sc-web-"));
      const args = [
        headless ? "--headless=new" : "--headless=false",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--remote-debugging-address=127.0.0.1",
        `--remote-debugging-port=${debugPort}`,
        "--remote-allow-origins=*",
        `--user-data-dir=${join(this.userDataDir, "profile")}`,
        "--window-size=1280,900",
        ...this.options.chromeFlags,
        "about:blank",
      ];
      const { spawn } = await import("node:child_process");
      this.assertChromePath(chromePath);
      const child = spawn(chromePath, args, { stdio: "ignore", detached: true });
      child.unref();
      this.chromeProcess = child;
      this.launchedHere = true;
      const deadline = Date.now() + timeoutMs;
      let ready = false;
      while (Date.now() < deadline) {
        if (await this.probeCdp(debugPort).catch(() => false)) {
          ready = true;
          break;
        }
        await sleep(400);
      }
      if (!ready) {
        throw new AppError(
          "INTERNAL",
          `Chromium did not expose a CDP endpoint on port ${debugPort}. Set SC_WEB_CHROME to a working Chrome/Chromium binary.`,
          { status: 500, details: { chromePath, debugPort } }
        );
      }
      this.browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${debugPort}` });
    }

    const page = await this.browser.newPage();
    await page.setUserAgent(this.options.userAgent);
    const cookies = this.readCookies(cookieFile);
    if (cookies.length > 0) await page.setCookie(...cookies);
    this.page = page;
    await this.navigate(uploadUrl);
    this.log("info", "web action session ready");
  }

  /** Switch the session to another SoundCloud page and rediscover its actions. */
  async navigate(url: string): Promise<void> {
    const page = this.pageHandle;
    await page.goto(url, { waitUntil: "load", timeout: this.options.timeoutMs });
    await page.waitForFunction(() => document.readyState === "complete", { timeout: this.options.timeoutMs }).catch(() => undefined);
    // Give the Next.js client a moment to hydrate before installing the bridge.
    await sleep(3000);
    await this.dismissConsent();
    await this.injectRuntime();
    this.actions.clear();
  }

  private async probeCdp(port: number): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: controller.signal });
      return response.ok;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Reject an unusable/world-writable Chrome binary when an absolute path is configured. */
  private assertChromePath(chromePath: string): void {
    if (!chromePath.includes("/")) return;
    try {
      const info = statSync(chromePath);
      if (!info.isFile()) throw new Error("not a regular file");
      if ((info.mode & 0o111) === 0) throw new Error("not executable");
      if ((info.mode & 0o002) !== 0) this.log("warn", `Chrome binary ${chromePath} is world-writable.`);
    } catch (error) {
      throw new AppError("INTERNAL", `SC_WEB_CHROME is not a usable executable: ${chromePath}`, {
        status: 500,
        details: { error: String(error) },
      });
    }
  }

  private readCookies(file: string): CookieEntry[] {
    if (!existsSync(file)) {
      throw new AppError(
        "UNAUTHORIZED",
        `SoundCloud web cookies not found at ${file}. Export them with scripts/stealth-import-cookies.py or set SC_WEB_COOKIE_FILE.`,
        { status: 401 }
      );
    }
    const raw = JSON.parse(readFileSync(file, "utf8")) as { cookies?: CookieEntry[] };
    try {
      const mode = statSync(file).mode & 0o777;
      if ((mode & 0o077) !== 0) {
        this.log("warn", `Cookie file ${file} is accessible by group/others (mode ${mode.toString(8)}); run chmod 600 on it.`);
      }
    } catch {
      // Permission inspection is best effort.
    }
    const entries = Array.isArray(raw.cookies) ? raw.cookies : [];
    return entries.filter((cookie) => cookie?.name && cookie?.value && cookie?.domain);
  }

  private async dismissConsent(): Promise<void> {
    const page = this.pageHandle;
    const clicked = await page.evaluate(() => {
      const allow = document.querySelector("#accept-recommended-btn-handler");
      if (allow instanceof HTMLElement) {
        allow.click();
        return true;
      }
      const close = document.querySelector("#close-pc-btn-handler");
      if (close instanceof HTMLElement) {
        close.click();
        return true;
      }
      return false;
    });
    if (clicked) await sleep(800);
  }

  private async injectRuntime(): Promise<void> {
    const page = this.pageHandle;
    const installed = await page.evaluate((moduleId: number, chunkPath: string): { ok: boolean; reason?: string } => {
      const g = globalThis as unknown as {
        TURBOPACK?: { push: (chunk: unknown) => void };
        __scInjectState?: string;
        __scCreateServerReference?: unknown;
      };
      if (!g.TURBOPACK || typeof g.TURBOPACK.push !== "function") return { ok: false, reason: "no turbopack runtime" };
      try {
        g.TURBOPACK.push([
          chunkPath,
          moduleId,
          function (runtime: { i: (id: number) => Record<string, unknown> }) {
            try {
              const client = runtime.i(253563) as {
                createServerReference: unknown;
                callServer: unknown;
                findSourceMapURL: unknown;
              };
              g.__scCreateServerReference = client.createServerReference;
              (g as Record<string, unknown>).__scCallServer = client.callServer;
              (g as Record<string, unknown>).__scFindSourceMapURL = client.findSourceMapURL;
              g.__scInjectState = "ok";
            } catch (error) {
              g.__scInjectState = `error: ${String(error)}`;
            }
          },
        ]);
        g.TURBOPACK.push([chunkPath, { otherChunks: [], runtimeModuleIds: [moduleId] }]);
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: String(error) };
      }
    }, INJECT_MODULE_ID, INJECT_CHUNK_PATH);
    if (!installed.ok) {
      throw new AppError("INTERNAL", `Could not install the server-action bridge: ${installed.reason ?? "unknown error"}`, {
        status: 500,
      });
    }
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const state = await page.evaluate(() => (globalThis as unknown as { __scInjectState?: string }).__scInjectState);
      if (state === "ok") return;
      if (state && state.startsWith("error")) {
        throw new AppError("INTERNAL", `Server-action bridge failed: ${state}`, { status: 500 });
      }
      await sleep(150);
    }
    throw new AppError("INTERNAL", "Timed out installing the server-action bridge.", { status: 500 });
  }

  private buildChunkUrls(loaded: string[]): { urls: string[]; suffix: string } {
    const suffix = loaded.map((url) => new URL(url).search).find((search) => search.length > 0) ?? "";
    const urls = new Set(loaded);
    return { urls: [...urls], suffix };
  }

  /** Fetch the page's loaded chunks plus the lazy chunks its loader maps reference. */
  async discoverActions(): Promise<DiscoveredActions> {
    const page = this.pageHandle;
    const loaded = await page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter((name) => name.includes("/_next/static/chunks/") && name.includes(".js"))
    );
    const { urls, suffix } = this.buildChunkUrls(loaded);
    const queue = [...urls];
    const seen = new Set(queue);
    const actions = new Map<string, string>();
    let chunkCount = 0;
    while (queue.length > 0 && chunkCount < 400) {
      const batch = queue.splice(0, 8);
      await Promise.all(
        batch.map(async (url) => {
          if (!seen.has(url)) return;
          try {
            const response = await fetch(url);
            if (!response.ok) return;
            const source = await response.text();
            chunkCount += 1;
            for (const [name, id] of parseServerReferences(source)) actions.set(name, id);
            for (const path of extractChunkPaths(source)) {
              const absolute = new URL(`${path}${suffix}`, ASSET_BASE).toString();
              if (!seen.has(absolute)) {
                seen.add(absolute);
                queue.push(absolute);
              }
            }
          } catch {
            // A missing optional chunk must not break discovery.
          }
        })
      );
    }
    this.actions = actions;
    this.chunkCount = chunkCount;
    this.log("debug", `discovered ${actions.size} server actions across ${chunkCount} chunks`);
    return { actions, chunkCount };
  }

  /** Call a discovered server action through the app's own callServer runtime. */
  async call<T = unknown>(name: string, ...args: unknown[]): Promise<T> {
    if (this.actions.size === 0) await this.discoverActions();
    const actionId = this.actions.get(name);
    if (!actionId) {
      throw new AppError("NOT_FOUND", `Server action "${name}" was not found in the live client bundle.`, {
        status: 404,
        details: { discovered: [...this.actions.keys()].sort() },
      });
    }
    return this.pageHandle.evaluate(
      async (id: string, callArgs: unknown[], actionName: string) => {
        const g = globalThis as unknown as {
          __scInjectState?: string;
          __scCreateServerReference: (id: string, call: unknown, a: unknown, b: unknown, name: string) => (...values: unknown[]) => Promise<unknown>;
          __scCallServer: unknown;
          __scFindSourceMapURL: unknown;
        };
        if (g.__scInjectState !== "ok") throw new Error(`Server-action bridge unavailable: ${g.__scInjectState ?? "not installed"}`);
        const reference = g.__scCreateServerReference(id, g.__scCallServer, undefined, g.__scFindSourceMapURL, actionName);
        return reference(...callArgs);
      },
      actionId,
      args,
      name
    ) as Promise<T>;
  }

  /** GET a JSON resource from api-v2 using the session's OAuth cookie. */
  async apiGet<T = unknown>(path: string, clientId?: string): Promise<T> {
    const page = this.pageHandle;
    const cookies = await page.cookies("https://soundcloud.com");
    const token = cookies.find((cookie) => cookie.name === "oauth_token")?.value;
    if (!token) throw new AppError("UNAUTHORIZED", "No oauth_token cookie in the browser session.", { status: 401 });
    const claims = decodeJwtPayload(token);
    const claimClientId = typeof claims?.client_id === "string" ? claims.client_id : undefined;
    const resolvedClientId = clientId ?? process.env.SC_WEB_CLIENT_ID ?? claimClientId;
    const url = `https://api-v2.soundcloud.com${path}${path.includes("?") ? "&" : "?"}client_id=${encodeURIComponent(resolvedClientId ?? "")}`;
    return page.evaluate(
      async (target: string, authToken: string) => {
        const response = await fetch(target, {
          headers: { Authorization: `OAuth ${authToken}`, Accept: "application/json" },
          credentials: "include",
        });
        if (!response.ok) throw new Error(`api-v2 ${response.status}: ${(await response.text()).slice(0, 200)}`);
        return response.json();
      },
      url,
      token
    ) as Promise<T>;
  }

  async close(): Promise<void> {
    try {
      if (this.browser) await this.browser.disconnect();
    } catch {
      // Disconnect is best effort.
    }
    this.browser = null;
    this.page = null;
    if (this.launchedHere && this.chromeProcess) {
      try {
        this.chromeProcess.kill("SIGTERM");
      } catch {
        // Browser may already be gone.
      }
      this.chromeProcess = null;
    }
    if (this.userDataDir) {
      try {
        rmSync(this.userDataDir, { recursive: true, force: true });
      } catch {
        // Temp profile cleanup is best effort.
      }
      this.userDataDir = null;
    }
  }
}
