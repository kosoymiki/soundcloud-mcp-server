#!/usr/bin/env node
/*
 * Small operator CLI for the SoundCloud MCP server.
 * Uses the local HTTP API; no dependencies. Tokens are read from the
 * environment or the server's DATA_DIR/local-token file, never printed.
 *
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { openAsBlob, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, basename } from "node:path";
import { spawn } from "node:child_process";

const BASE = (process.env.SC_MCP_URL ?? process.env.PUBLIC_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const DATA_DIR = (process.env.DATA_DIR ?? join(homedir(), ".local", "share", "soundcloud-mcp")).replace(/^~/, homedir());

function token() {
  if (process.env.SC_MCP_TOKEN) return process.env.SC_MCP_TOKEN.trim();
  try {
    return readFileSync(join(DATA_DIR, "local-token"), "utf8").trim();
  } catch {
    console.error(`No token. Set SC_MCP_TOKEN or create ${join(DATA_DIR, "local-token")}.`);
    process.exit(2);
  }
}

function headers(extra = {}) {
  return { authorization: `Bearer ${token()}`, "x-scmcp-csrf": "1", ...extra };
}

async function api(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: headers(options.headers ?? {}),
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    const message = body?.message || body?.error_description || body?.error || `HTTP ${response.status}`;
    throw new Error(typeof message === "string" ? message : JSON.stringify(message));
  }
  return body;
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

function parseFlags(args) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split("=");
      if (inline !== undefined) flags[key] = inline;
      else if (args[i + 1] && !args[i + 1].startsWith("--")) flags[key] = args[++i];
      else flags[key] = true;
    } else {
      rest.push(arg);
    }
  }
  return { flags, rest };
}

const HELP = `SoundCloud MCP CLI
  sc.mjs status                     server + connection health
  sc.mjs me                         profile and quota
  sc.mjs tracks [--limit 25]        my tracks
  sc.mjs playlists                  my playlists
  sc.mjs upload <file> [options]    upload an audio file
      --title <t> --artist <a> --genre <g> --tags "a,b" --description <d>
      --sharing private|public --no-auto-tag
  sc.mjs panel                      print the browser panel URL
  sc.mjs auth                       open the SoundCloud authorization window
      --client-id <id> --client-secret <secret>   store app credentials once, then open
      (or set SC_CLIENT_ID / SC_CLIENT_SECRET in the environment)
  sc.mjs open                       open the studio in the default browser
  sc.mjs raw <path>                 authenticated GET of any panel API path

Environment: SC_MCP_URL (default http://127.0.0.1:3000), SC_MCP_TOKEN or DATA_DIR/local-token.
`;

async function openUrl(url) {
  const candidates = [];
  const termux = process.platform === "android" || process.env.TERMUX_VERSION || (process.env.PREFIX || "").includes("com.termux");
  if (termux) candidates.push(["termux-open-url", [url]]);
  if (process.platform === "win32") candidates.push(["cmd", ["/c", "start", "", url]]);
  if (process.platform === "darwin") candidates.push(["open", [url]]);
  if (process.env.WSL_DISTRO_NAME) {
    candidates.push(["cmd.exe", ["/c", "start", "", url]]);
    candidates.push(["wslview", [url]]);
  }
  candidates.push(["xdg-open", [url]], ["gio", ["open", url]], ["sensible-browser", [url]]);

  for (const [command, args] of candidates) {
    const ok = await new Promise((resolve) => {
      let child;
      try {
        child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true });
      } catch {
        resolve(false);
        return;
      }
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    });
    if (ok) return true;
  }
  return false;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const { flags } = parseFlags(args);

  switch (command) {
    case "status": {
      const health = await fetch(`${BASE}/health`).then((response) => response.json());
      print(health);
      break;
    }
    case "me": {
      print(await api("/api/state").then((state) => ({ me: state.me, quota: state.quota })));
      break;
    }
    case "tracks": {
      const limit = Number(flags.limit ?? 25);
      print(await api(`/api/tracks?limit=${limit}`));
      break;
    }
    case "playlists": {
      print(await api("/api/playlists"));
      break;
    }
    case "upload": {
      const file = args[0];
      if (!file) throw new Error("Usage: sc.mjs upload <file> [--title ...]");
      const path = resolve(file);
      const blob = await openAsBlob(path);
      const metadata = {
        ...(flags.title ? { title: String(flags.title) } : {}),
        ...(flags.artist ? { artist: String(flags.artist) } : {}),
        ...(flags.genre ? { genre: String(flags.genre) } : {}),
        ...(flags.tags ? { tags: String(flags.tags) } : {}),
        ...(flags.description ? { description: String(flags.description) } : {}),
        ...(flags.sharing ? { sharing: String(flags.sharing) } : {}),
      };
      const form = new FormData();
      form.set("metadata", JSON.stringify(metadata));
      form.set("upload_id", `cli_${Date.now()}`);
      form.set("file", blob, basename(path));
      if (flags["no-auto-tag"]) form.set("auto_tag", "false");
      const result = await api("/api/upload", { method: "POST", body: form });
      print(result);
      break;
    }
    case "panel": {
      console.log(`${BASE}/panel`);
      break;
    }
    case "open": {
      const url = `${BASE}/panel`;
      const opened = await openUrl(url);
      console.log(opened ? `opened ${url}` : `open manually: ${url}`);
      break;
    }
    case "auth": {
      const clientId = flags["client-id"] || process.env.SC_CLIENT_ID;
      const clientSecret = flags["client-secret"] || process.env.SC_CLIENT_SECRET;
      if (clientId && clientSecret) {
        const saved = await fetch(`${BASE}/panel/setup`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id: String(clientId), client_secret: String(clientSecret) }),
          redirect: "manual",
        });
        if (saved.status >= 400 && saved.status !== 302) {
          const text = await saved.text();
          throw new Error(`Could not store app credentials (HTTP ${saved.status}): ${text.slice(0, 200)}`);
        }
      }
      const url = `${BASE}/panel/auth/start`;
      const opened = await openUrl(url);
      console.log(opened ? `opened ${url}` : `open manually: ${url}`);
      break;
    }
    case "raw": {
      const path = args[0];
      if (!path) throw new Error("Usage: sc.mjs raw </api/path>");
      print(await api(path));
      break;
    }
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(HELP);
      break;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
