/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
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

export function registerProjectResources(server: McpServer): void {
  server.registerResource(
    "project-guide",
    "soundcloud://guide",
    {
      title: "SoundCloud MCP project guide",
      description: "Golden path, auth options, web-session pipeline, audio and security rules.",
      mimeType: "text/markdown",
    },
    async (uri) => ({ contents: [{ uri: uri.href, text: GUIDE }] })
  );

  server.registerPrompt(
    "plan_upload",
    {
      title: "Plan a SoundCloud upload",
      description: "Returns a concrete plan for uploading a file (API or web session) and verifying it.",
      argsSchema: {
        file: z.string().describe("Absolute path to the audio file"),
        title: z.string().optional().describe("Track title"),
        album: z.string().optional().describe("Existing album URN or album title"),
      },
    },
    ({ file, title, album }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Upload plan for ${file}`,
              `1. Confirm auth path: API app if registered, otherwise web session with SC_WEB_COOKIE_FILE.`,
              `2. If the file must be edited, trim/slow it first and re-measure duration/LUFS/true peak.`,
              `3. Call web_upload_track with file_path="${file}"${title ? `, title="${title}"` : ""}${album ? `, album_title or album_urn="${album}"` : ""}.`,
              `4. Verify: track page duration/state, album track_count, no duplicate title.`,
              `5. Report Goal | Actions | Evidence | Result | Risks with URLs and IDs.`,
            ].join("\n"),
          },
        },
      ],
    })
  );
}
