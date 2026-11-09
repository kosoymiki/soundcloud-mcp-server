/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Opens a URL in the user's normal browser/webview on every supported platform.
 * No shell is involved: commands are spawned with argument arrays.
 */

import { spawn } from "node:child_process";

export type PlatformKind = "android" | "windows" | "wsl" | "macos" | "linux" | "unknown";

export interface OpenInBrowserResult {
  opened: boolean;
  platform: PlatformKind;
  command?: string;
  reason?: string;
}

function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, ["--version"], { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(false);
    }, 1_500);
    timer.unref();
    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("spawn", () => {
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve(true);
    });
  });
}

function trySpawn(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    let child;
    try {
      child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true });
    } catch {
      finish(false);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, 5_000);
    timer.unref();
    child.once("error", () => finish(false));
    child.once("spawn", () => {
      child.unref();
      finish(true);
    });
  });
}

export function detectPlatform(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): PlatformKind {
  if (platform === "android" || env.TERMUX_VERSION || env.PREFIX?.includes("com.termux")) return "android";
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  if (platform === "linux") {
    if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return "wsl";
    return "linux";
  }
  return "unknown";
}

/** Opens a URL in the default browser. Never throws. */
export async function openInBrowser(
  url: string,
  options: { platform?: PlatformKind } = {}
): Promise<OpenInBrowserResult> {
  const platform = options.platform ?? detectPlatform();
  const candidates: Array<{ command: string; args: string[] }> = [];

  switch (platform) {
    case "android":
      candidates.push({ command: "termux-open-url", args: [url] });
      candidates.push({ command: "xdg-open", args: [url] });
      break;
    case "windows":
      candidates.push({ command: "cmd", args: ["/c", "start", "", url] });
      break;
    case "wsl":
      candidates.push({ command: "cmd.exe", args: ["/c", "start", "", url] });
      candidates.push({ command: "wslview", args: [url] });
      candidates.push({ command: "xdg-open", args: [url] });
      break;
    case "macos":
      candidates.push({ command: "open", args: [url] });
      break;
    case "linux":
      candidates.push({ command: "xdg-open", args: [url] });
      candidates.push({ command: "gio", args: ["open", url] });
      candidates.push({ command: "sensible-browser", args: [url] });
      break;
    default:
      break;
  }

  for (const candidate of candidates) {
    if (!(await commandExists(candidate.command))) continue;
    if (await trySpawn(candidate.command, candidate.args)) {
      return {
        opened: true,
        platform,
        command: `${candidate.command} ${candidate.args.map((arg) => (arg === url ? "<url>" : arg)).join(" ")}`,
      };
    }
  }

  return {
    opened: false,
    platform,
    reason:
      platform === "android"
        ? "termux-open-url/xdg-open not found. Install termux-api or open the URL manually."
        : `No browser opener found for ${platform}. Open the URL manually.`,
  };
}
