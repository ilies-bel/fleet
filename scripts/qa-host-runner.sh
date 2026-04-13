#!/bin/bash
set -euo pipefail

# ─── Host-side AppleScript relay ─────────────────────────────────────────────
# The gateway container (Linux) cannot run osascript. This script starts a
# tiny Python3 HTTP server on the Mac host (127.0.0.1:4001) so the gateway
# can POST /run-osascript and have it executed locally.
# Called by qa-init.sh on startup; PID saved to .qa-runner.pid.

PORT=4001
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
QA_FLEET_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PID_FILE="${QA_FLEET_ROOT}/.qa-runner.pid"

if [ -t 1 ]; then
  GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; RESET='\033[0m'
else
  GREEN=''; YELLOW=''; RED=''; RESET=''
fi

info()  { echo -e "${GREEN}[qa-host-runner]${RESET} $*"; }
warn()  { echo -e "${YELLOW}[qa-host-runner]${RESET} $*"; }
error() { echo -e "${RED}[qa-host-runner] ERROR:${RESET} $*" >&2; exit 1; }

# ─── Already running? ─────────────────────────────────────────────────────────
if [ -f "${PID_FILE}" ]; then
  OLD_PID=$(cat "${PID_FILE}")
  if kill -0 "${OLD_PID}" 2>/dev/null; then
    warn "Already running (PID ${OLD_PID})"
    exit 0
  fi
  rm -f "${PID_FILE}"
fi

# ─── Require python3 ──────────────────────────────────────────────────────────
command -v python3 >/dev/null 2>&1 || error "python3 is required"

# ─── Start HTTP server in background ─────────────────────────────────────────
python3 - << 'PYEOF' &
import json, subprocess
from http.server import HTTPServer, BaseHTTPRequestHandler

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass  # suppress access logs

    def do_GET(self):
        if self.path == '/health':
            self._ok(b'{"ok":true}')
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path == '/run-osascript':
            n = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(n))
            script = body.get('script', '')
            if script:
                subprocess.Popen(['osascript', '-e', script])
            self._ok(b'{"ok":true}')
        else:
            self.send_response(404)
            self.end_headers()

    def _ok(self, body):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

HTTPServer(('127.0.0.1', 4001), Handler).serve_forever()
PYEOF

RUNNER_PID=$!
echo "${RUNNER_PID}" > "${PID_FILE}"
info "Started on 127.0.0.1:${PORT} (PID ${RUNNER_PID})"
