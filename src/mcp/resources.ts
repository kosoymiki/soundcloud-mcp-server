/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Project resources and prompts defined once as transport-neutral specs, so the
 * legacy (2025-11-25) SDK server and the modern (2026-07-28) FastMCP server
 * expose identical content.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const GUIDE = `# soundcloud-mcp-server operating guide

1. Install: bash install-termux.sh (or npm ci && npm run build && npm test).
2. Configure .env (PUBLIC_URL, MCP_MODE, SC_MEDIA_DIRS, audio paths).
3. Auth: API app (node scripts/sc.mjs auth ...) OR web session
   (export cookies with scripts/stealth-import-cookies.py, chmod 600,
   set SC_WEB_COOKIE_FILE).
4. Run: npm start -> panel /panel, MCP /mcp (Bearer MCP_LOCAL_TOKEN or OAuth).
5. Web upload path: web_upload_track (optional album_title / album_urn);
   actions are discovered live, ids change per deployment.
6. Audio: trim at a 5ms RMS minimum before an attack; slow via asetrate;
   master ~-11 LUFS, true peak <= -1 dBTP; verify with ebur128.
7. Security: never commit secrets, keep cookies 0600, no CAPTCHA bypass.
8. Done: typecheck rc 0, 48/48 tests, build, live /health smoke.
`;

export interface ProjectResourceSpec {
  name: string;
  uri: string;
  title: string;
  description: string;
  mimeType: string;
  /** Returns the resource body as text. */
  read: () => string;
}

export interface ProjectPromptSpec {
  name: string;
  title: string;
  description: string;
  arguments: { name: string; description?: string; required?: boolean }[];
  /** Renders the prompt body from client-supplied arguments. */
  render: (args: Record<string, string | undefined>) => string;
}

const PLAN_UPLOAD_ARGS: ProjectPromptSpec["arguments"] = [
  { name: "file", description: "Absolute path to the audio file", required: true },
  { name: "title", description: "Track title", required: false },
  { name: "album", description: "Existing album URN or album title", required: false },
];

export const PROJECT_RESOURCES: readonly ProjectResourceSpec[] = [
  {
    name: "project-guide",
    uri: "soundcloud://guide",
    title: "SoundCloud MCP project guide",
    description: "Golden path, auth options, web-session pipeline, audio and security rules.",
    mimeType: "text/markdown",
    read: () => GUIDE,
  },
];

export const PROJECT_PROMPTS: readonly ProjectPromptSpec[] = [
  {
    name: "plan_upload",
    title: "Plan a SoundCloud upload",
    description: "Returns a concrete plan for uploading a file (API or web session) and verifying it.",
    arguments: PLAN_UPLOAD_ARGS,
    render: ({ file, title, album }) =>
      [
        `Upload plan for ${file ?? "(file not supplied)"}`,
        `1. Confirm auth path: API app if registered, otherwise web session with SC_WEB_COOKIE_FILE.`,
        `2. If the file must be edited, trim/slow it first and re-measure duration/LUFS/true peak.`,
        `3. Call web_upload_track with file_path="${file ?? ""}"${title ? `, title="${title}"` : ""}${
          album ? `, album_title or album_urn="${album}"` : ""
        }.`,
        `4. Verify: track page duration/state, album track_count, no duplicate title.`,
        `5. Report Goal | Actions | Evidence | Result | Risks with URLs and IDs.`,
      ].join("\n"),
  },
];

/** Legacy (2025-11-25) registration on the official SDK server. */
export function registerProjectResources(server: McpServer): void {
  for (const resource of PROJECT_RESOURCES) {
    server.registerResource(
      resource.name,
      resource.uri,
      {
        title: resource.title,
        description: resource.description,
        mimeType: resource.mimeType,
      },
      async (uri) => ({ contents: [{ uri: uri.href, text: resource.read() }] })
    );
  }

  for (const prompt of PROJECT_PROMPTS) {
    const argsSchema: Record<string, z.ZodTypeAny> = {};
    for (const arg of prompt.arguments) {
      const field = z.string();
      argsSchema[arg.name] = arg.required
        ? field.describe(arg.description ?? "")
        : field.optional().describe(arg.description ?? "");
    }
    server.registerPrompt(
      prompt.name,
      {
        title: prompt.title,
        description: prompt.description,
        argsSchema,
      },
      (args) => ({
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: prompt.render(args as Record<string, string | undefined>),
            },
          },
        ],
      })
    );
  }
}
