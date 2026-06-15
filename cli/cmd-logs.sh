#!/bin/bash
# cmd-logs.sh — Error-focused diagnostic surface over fleet feature container logs
set -euo pipefail

# ─── Resolve paths ───────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLEET_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
export FLEET_ROOT

# Source shared library
# shellcheck source=./common.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/common.sh"

# ─── Help ────────────────────────────────────────────────────────────────────
_logs_help() {
  local exit_code="${1:-0}"
  echo ""
  echo -e "${GREEN}fleet logs${RESET} — error-focused diagnostic surface for fleet feature containers"
  echo ""
  echo "Usage: fleet logs [<name>] [--trace] [--tail <n>] [-f]"
  echo ""
  echo "Arguments:"
  echo -e "  ${BLUE}<name>${RESET}         Feature name (optional; omit to scan ALL features)"
  echo ""
  echo "Flags:"
  echo -e "  ${BLUE}--trace${RESET}        Bypass classification — exec raw 'docker logs' for <name>. Requires <name>."
  echo -e "  ${BLUE}--tail <n>${RESET}     Lines to inspect (default: 400). Passed through to docker logs with --trace."
  echo -e "  ${BLUE}-f, --follow${RESET}   Follow log output (only valid with --trace + <name>)"
  echo -e "  ${BLUE}-h, --help${RESET}     Show this help"
  echo ""
  echo "Modes:"
  echo "  fleet logs             Scan ALL features — print only unhealthy ones (terse cause line per problem)"
  echo "  fleet logs <name>      Drill into ONE feature — confirm health or report cause + --trace hint"
  echo "  fleet logs <name> --trace   Bypass classification — exec raw 'docker logs' for that container"
  echo ""
  echo "Examples:"
  echo "  fleet logs"
  echo "  fleet logs qa-main"
  echo "  fleet logs qa-main --trace"
  echo "  fleet logs qa-main --trace --tail 1000 -f"
  echo ""
  exit "${exit_code}"
}

# ─── Argument parsing ────────────────────────────────────────────────────────
NAME=""
TRACE=false
TAIL=400
FOLLOW=false

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)
      _logs_help 0
      ;;
    --trace)
      TRACE=true
      shift
      ;;
    --tail)
      if ! [[ "${2:-}" =~ ^[0-9]+$ ]]; then
        error "fleet logs: --tail requires a positive integer (got '${2:-}')\nRun 'fleet logs --help' for usage."
      fi
      TAIL="${2}"
      shift 2
      ;;
    -f|--follow)
      FOLLOW=true
      shift
      ;;
    --*)
      error "fleet logs: unknown flag '${1}'\nRun 'fleet logs --help' for usage."
      ;;
    *)
      if [ -z "${NAME}" ]; then
        NAME="${1}"
        shift
      else
        error "fleet logs: unexpected argument '${1}'\nRun 'fleet logs --help' for usage."
      fi
      ;;
  esac
done

# ─── Validation ──────────────────────────────────────────────────────────────
if [ "${TRACE}" = true ] && [ -z "${NAME}" ]; then
  error "fleet logs: --trace requires a feature <name>\nRun 'fleet logs --help' for usage."
fi
if [ "${FOLLOW}" = true ] && { [ "${TRACE}" = false ] || [ -z "${NAME}" ]; }; then
  error "fleet logs: -f/--follow is only valid with --trace and a feature <name>"
fi

# Load project config (provides FLEET_CONFIG_ROOT, FLEET_PROJECT_NAME)
load_fleet_toml

# ─── --trace passthrough ─────────────────────────────────────────────────────
if [ "${TRACE}" = true ]; then
  CONTAINER_NAME="fleet-${FLEET_PROJECT_NAME}-${NAME}"
  if [ "${FOLLOW}" = true ]; then
    exec docker logs -f --tail "${TAIL}" "${CONTAINER_NAME}"
  else
    exec docker logs --tail "${TAIL}" "${CONTAINER_NAME}"
  fi
fi

# ─── Python log classifier ───────────────────────────────────────────────────
_PYBIN=$(_find_python_with_tomllib) \
  || error "No python3 with tomllib/tomli found. Install python >=3.11 or: pip3 install tomli"

# Embedded classifier: reads docker logs from stdin, outputs formatted diagnostic lines.
# Args: name inspect_out single_view(0|1) is_tty(0|1)
# shellcheck disable=SC2016
_CLASSIFIER_PY=$(cat <<'PYEOF'
import sys, re
from datetime import datetime, timedelta

name        = sys.argv[1]
inspect_out = sys.argv[2]
single_view = sys.argv[3] == '1'
is_tty      = sys.argv[4] == '1'

if is_tty:
    GREEN  = '\033[0;32m'
    YELLOW = '\033[1;33m'
    RED    = '\033[0;31m'
    DIM    = '\033[2m'
    RESET  = '\033[0m'
else:
    GREEN = YELLOW = RED = DIM = RESET = ''

# Parse docker inspect output: RestartCount|State.Status|Health.Status|ExitCode
_parts        = inspect_out.split('|', 3)
status        = _parts[1] if len(_parts) > 1 else 'unknown'
health        = _parts[2] if len(_parts) > 2 else 'none'
_ec           = _parts[3] if len(_parts) > 3 else '0'
exit_code     = int(_ec) if _ec.lstrip('-').isdigit() else 0

# Read docker logs from stdin
log_lines = sys.stdin.read().splitlines()

# ─── Supervisord pattern matchers ────────────────────────────────────────────
# Log line format: "2026-06-15 15:18:40,775 INFO  exited: backend (exit status 1; not expected)"
SUPERVISORD_TS_RE   = re.compile(
    r'^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d{3}\s+(?:INFO|WARN|ERRO|CRIT)\s+(.*)'
)
UNEXPECTED_EXIT_RE  = re.compile(
    r'exited:\s+([a-zA-Z0-9_-]+)\s+\(.*?not expected\)'
)
SUPERVISORD_META_RE = re.compile(
    r'^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3}\s+(?:INFO|WARN|ERRO|CRIT)'
)

# ─── Time-bounding rule ───────────────────────────────────────────────────────
# Count only unexpected exits whose supervisord timestamp falls within the last
# WINDOW_MINUTES.  A single historical "not expected" exit on an otherwise-
# running container (e.g. fleet-gustave-qa-main with 1 stale backend exit) must
# NOT trigger crash-looping.  Rule: crash-looping requires >=2 in-window exits.
# Historical-only exits are surfaced as "recovered" in single-view only.
WINDOW_MINUTES = 10
now    = datetime.now()
cutoff = now - timedelta(minutes=WINDOW_MINUTES)

in_window  = {}   # svc -> count within last WINDOW_MINUTES
historical = {}   # svc -> total count

for line in log_lines:
    m = SUPERVISORD_TS_RE.match(line)
    if not m:
        continue
    ts_str, msg = m.group(1), m.group(2)
    em = UNEXPECTED_EXIT_RE.search(msg)
    if not em:
        continue
    svc = em.group(1)
    historical[svc] = historical.get(svc, 0) + 1
    try:
        ts = datetime.strptime(ts_str, '%Y-%m-%d %H:%M:%S')
        if ts >= cutoff:
            in_window[svc] = in_window.get(svc, 0) + 1
    except ValueError:
        pass

# ─── Cause extraction ────────────────────────────────────────────────────────
# Find the most recent app-level error line (non-supervisord, non-benign).
# This is the root cause of the crash, NOT the supervisord bookkeeping lines.
BENIGN_RE = re.compile(
    r'LOG:.*(?:checkpoint|shutdown|recovery|archive|autovacuum)'
    r'|\.env: line \d+:.*command not found'
    r'|SyntaxWarning:.*invalid escape'
    r'|\[fleet\]'
    r'|received SIGTERM indicating exit request'
    r'|waiting for .* to die'
    r'|reaped unknown pid'
    r'|gave SIGTERM to supervisord'
    r'|supervisord started with pid'
    r'|unlinking old worker socket',
    re.IGNORECASE,
)
APP_ERROR_RE = re.compile(
    r'FATAL|ERROR|Exception|Caused by:'
    r'|panic:|fatal error|Cannot |Connection refused'
    r'|EADDRINUSE|address already in use'
    r'|OOM|Killed|ModuleNotFoundError|ModuleNotFound'
    r'|Traceback \(most recent'
    r'|undefined reference|no such file or directory'
    r'|Error:',
    re.IGNORECASE,
)

cause_line = None
for line in reversed(log_lines):
    if SUPERVISORD_META_RE.match(line):
        continue
    if BENIGN_RE.search(line):
        continue
    stripped = line.strip()
    if stripped and APP_ERROR_RE.search(stripped):
        cause_line = stripped[:120]
        break

def _generic_cause(code):
    if code == 1:
        return 'exit {} (likely build/start failure)'.format(code)
    if code in (137, 143, 130):
        return 'exit {} (OOM/killed)'.format(code)
    return 'exit {}'.format(code)

# ─── Build problem sets ───────────────────────────────────────────────────────
problems_crash     = []   # (svc, count) — in-window crash-loops; always shown
problems_recovered = []   # (svc, count) — historical-only; single-view only

for svc, count in in_window.items():
    if count >= 2:
        problems_crash.append((svc, count))

for svc, count in historical.items():
    if svc not in in_window and status == 'running':
        problems_recovered.append((svc, count))

# ─── Container-level verdict ─────────────────────────────────────────────────
if status in ('exited', 'dead') and exit_code != 0:
    verdict = 'down'
elif status in ('exited', 'dead') and exit_code == 0:
    verdict = 'stopped-clean'
elif problems_crash or health == 'unhealthy':
    verdict = 'unhealthy'
else:
    verdict = 'healthy'

# ─── Format output ────────────────────────────────────────────────────────────
# In all-scan mode (single_view=False): output nothing for healthy containers.
# In single-view mode (single_view=True): always output something.
out = []

if verdict == 'healthy':
    if single_view:
        hint = "run 'fleet logs {} --trace' for full output".format(name)
        out.append('{}✓{} {}  no errors detected   ·   {}'.format(
            GREEN, RESET, name, hint))
        for svc, count in problems_recovered:
            cause = cause_line or _generic_cause(exit_code)
            out.append('{}{} restarted {}× (now running) — last cause: {}{}'.format(
                YELLOW, svc, count, cause, RESET))

elif verdict == 'unhealthy':
    for svc, count in problems_crash:
        cause = cause_line or _generic_cause(exit_code)
        out.append('{}{} ✗ crash-looping ({} unexpected exits in last {}m) — {}{}'.format(
            RED, svc, count, WINDOW_MINUTES, cause, RESET))
    if not problems_crash:
        # Docker healthcheck unhealthy but no supervisord crash-loop detected
        cause = cause_line or _generic_cause(exit_code)
        out.append('{}{} ✗ unhealthy — {}{}'.format(RED, name, cause, RESET))
    if single_view:
        out.append('{}  run: fleet logs {} --trace{}'.format(DIM, name, RESET))

elif verdict == 'down':
    cause = cause_line or _generic_cause(exit_code)
    out.append('{}{} ✗ exited unexpectedly — {}{}'.format(RED, name, cause, RESET))
    if single_view:
        out.append('{}  run: fleet logs {} --trace{}'.format(DIM, name, RESET))

elif verdict == 'stopped-clean':
    if single_view:
        out.append('{}{}  stopped (clean exit 0){}'.format(DIM, name, RESET))
    # all-scan: omit stopped-clean containers

if out:
    print('\n'.join(out))
PYEOF
)

# ─── Classify one feature container ──────────────────────────────────────────
# Prints formatted diagnostic lines to stdout (nothing when healthy + all-scan).
# Never exits non-zero — all errors are reported via warn() and the function
# returns, allowing the all-scan loop to continue.
_classify_feature() {
  local feature_name="${1}"
  local project="${2}"
  local single_view="${3}"   # "0" = all-scan, "1" = single-view
  local container_name="fleet-${project}-${feature_name}"

  # Container does not exist: print dim note and continue (never abort all-scan)
  if ! docker inspect "${container_name}" >/dev/null 2>&1; then
    if [ -t 1 ]; then
      printf '\033[2m%s  (not created)\033[0m\n' "${feature_name}"
    else
      printf '%s  (not created)\n' "${feature_name}"
    fi
    return 0
  fi

  local inspect_out
  inspect_out=$(docker inspect "${container_name}" \
    --format '{{.RestartCount}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.State.ExitCode}}' \
    2>/dev/null) || inspect_out="0|unknown|none|0"

  local logs_out
  logs_out=$(docker logs --tail "${TAIL}" "${container_name}" 2>&1) || logs_out=""

  local is_tty
  if [ -t 1 ]; then is_tty=1; else is_tty=0; fi

  printf '%s\n' "${logs_out}" \
    | "${_PYBIN}" -c "${_CLASSIFIER_PY}" \
        "${feature_name}" "${inspect_out}" "${single_view}" "${is_tty}" \
    || { warn "classifier failed for ${container_name}"; return 0; }
}

# ─── All-scan mode ───────────────────────────────────────────────────────────
if [ -z "${NAME}" ]; then
  shopt -s nullglob
  INFO_TOMLS=( "${FLEET_CONFIG_ROOT}/.fleet/"*/info.toml )
  shopt -u nullglob

  if [ "${#INFO_TOMLS[@]}" -eq 0 ]; then
    info "No features found. Run: fleet add <name>"
    exit 0
  fi

  any_problems=false
  for info_toml in "${INFO_TOMLS[@]}"; do
    row=$(_read_info_toml "${info_toml}") || row=""
    [ -n "${row}" ] || continue
    IFS='|' read -r f_project f_name _f_branch _f_title _f_added_at _f_svcs <<< "${row}"
    # Skip entries with missing project/name
    [ -n "${f_project}" ] && [ -n "${f_name}" ] || continue

    output=$(_classify_feature "${f_name}" "${f_project}" "0")
    if [ -n "${output}" ]; then
      printf '%s\n' "${output}"
      any_problems=true
    fi
  done

  if [ "${any_problems}" = false ]; then
    echo -e "${GREEN}no unhealthy instances${RESET}"
  fi
  exit 0
fi

# ─── Single-feature mode ─────────────────────────────────────────────────────
validate_feature_name "${NAME}"
output=$(_classify_feature "${NAME}" "${FLEET_PROJECT_NAME}" "1")
if [ -n "${output}" ]; then
  printf '%s\n' "${output}"
else
  warn "Could not classify container for feature '${NAME}'"
fi
