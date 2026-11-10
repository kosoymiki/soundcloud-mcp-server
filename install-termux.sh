#!/usr/bin/env bash
# Reproducible installer for soundcloud-mcp-server (Termux + Linux/macOS).
# Idempotent: safe to re-run. Usage: bash install-termux.sh [--skip-tests]
set -euo pipefail

SKIP_TESTS=0
for arg in "$@"; do
  case "$arg" in
    --skip-tests) SKIP_TESTS=1 ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
fail() { printf '\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

need_node() {
  command -v node >/dev/null 2>&1 || fail "node is not installed"
  major=$(node -p 'process.versions.node.split(".")[0]')
  minor=$(node -p 'process.versions.node.split(".")[1]')
  if [ "$major" -lt 24 ]; then
    fail "Node.js >= 24 required (node:sqlite is unflagged from Node 24; Node 22 needs --experimental-sqlite) (found $(node -v))"
  fi
  echo "node: $(node -v)  npm: $(npm -v)"
}

say "Checking environment"
if [ -n "${PREFIX:-}" ] && command -v pkg >/dev/null 2>&1; then
  echo "Termux detected ($PREFIX)"
  say "Installing system packages (nodejs git ffmpeg chromium python python-numpy)"
  pkg update -y || true
  pkg install -y nodejs git ffmpeg chromium python python-numpy
else
  echo "Non-Termux environment: verifying required commands"
  for c in node npm ffmpeg ffprobe git; do
    command -v "$c" >/dev/null 2>&1 || echo "WARN: missing '$c' (install it before web/audio features)"
  done
  command -v chromium-browser >/dev/null 2>&1 || command -v chromium >/dev/null 2>&1 || \
    echo "WARN: no Chromium found; web-session tools need SC_WEB_CHROME"
fi
need_node

say "Installing npm dependencies"
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund
else
  npm install --no-audit --no-fund
fi

say "Building TypeScript"
npm run typecheck
npm run build

if [ "$SKIP_TESTS" -eq 0 ]; then
  say "Running unit tests (72)"
  npm test
fi

say "Preparing configuration"
if [ ! -f .env ]; then
  cp .env.example .env
  echo "created .env from .env.example"
else
  echo ".env already exists (left untouched)"
fi
mkdir -p "${DATA_DIR:-$HOME/.local/share/soundcloud-mcp}"
chmod 700 "${DATA_DIR:-$HOME/.local/share/soundcloud-mcp}" || true

say "Next steps"
cat <<'EOF'
1. Edit .env: PUBLIC_URL, MCP_MODE, SC_MEDIA_DIRS, FFMPEG_PATH/FFPROBE_PATH.
2. Auth (choose one):
   A) Official API app:  node scripts/sc.mjs auth --client-id ... --client-secret ...
   B) Web session:       log in to soundcloud.com in a browser, then:
        node dist/web/cli.js cookies          # fresh cookies from Chrome (0600)
        node dist/web/cli.js doctor --probe   # verify the live session
        node dist/web/cli.js selftest         # full chain, deletes its own test data
3. Start:  npm start
   Panel: http://localhost:3000/panel
   MCP:   http://localhost:3000/mcp  (Authorization: Bearer <DATA_DIR/local-token>)
4. Verify: curl -s http://localhost:3000/health && npm run verify
5. Connect an MCP client: see "Connect an MCP client" in README.md.
6. Read the project master skill: .opencode/skills/soundcloud-mcp-server/SKILL.md
EOF
