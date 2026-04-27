#!/bin/bash
set -euo pipefail

# ─── Resolve paths ───────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLEET_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
export FLEET_ROOT

# Source shared library
# shellcheck source=./common.sh
source "${SCRIPT_DIR}/common.sh"

# ─── Help ────────────────────────────────────────────────────────────────────
_ls_help() {
  local exit_code="${1:-0}"
  echo ""
  echo -e "${GREEN}fleet ls${RESET} — list feature containers and status"
  echo ""
  echo "Usage: fleet ls [--json]"
  echo ""
  echo "Flags:"
  echo -e "  ${BLUE}--json${RESET}   Emit a JSON array of feature records instead of the human table"
  echo -e "  ${BLUE}-h${RESET}       Show this help"
  echo ""
  echo "Output columns (default table):"
  echo "  NAME      Feature name"
  echo "  PROJECT   Project the feature belongs to"
  echo "  BRANCH    Git branch"
  echo "  STATUS    Container status (up/down/building/…) — from gateway, or '—' if unreachable"
  echo "  SERVICES  name:port pairs (comma-separated)"
  echo "  ADDED     ISO timestamp from info.toml"
  echo ""
  echo "Examples:"
  echo "  fleet ls"
  echo "  fleet ls --json"
  echo "  fleet ls --json | python3 -m json.tool"
  echo ""
  exit "${exit_code}"
}

# ─── Argument parsing ────────────────────────────────────────────────────────
JSON_MODE=false

for arg in "$@"; do
  case "${arg}" in
    --json)    JSON_MODE=true ;;
    -h|--help) _ls_help 0 ;;
    *)
      error "fleet ls: unknown flag '${arg}'\nRun 'fleet ls --help' for usage."
      ;;
  esac
done

# Resolve per-project .fleet/ root
load_fleet_toml

# ─── Collect filesystem entries ───────────────────────────────────────────────
shopt -s nullglob
INFO_TOMLS=( "${FLEET_CONFIG_ROOT}/.fleet/"*/info.toml )
shopt -u nullglob

if [ "${#INFO_TOMLS[@]}" -eq 0 ]; then
  if [ "${JSON_MODE}" = true ]; then
    echo "[]"
  else
    info "No features. Run: fleet add <name>"
  fi
  exit 0
fi

# ─── Fetch gateway state (best-effort, 2s timeout) ───────────────────────────
GATEWAY_JSON=""
if GATEWAY_JSON=$(curl -sf --max-time 2 "${GATEWAY_URL}/_fleet/api/features" 2>/dev/null); then
  : # success
else
  warn "gateway unavailable — showing filesystem state only"
  GATEWAY_JSON="[]"
fi

# ─── Build row data ───────────────────────────────────────────────────────────
# Each element: name|project|branch|status|services|added_at
declare -a ROWS=()

for info_toml in "${INFO_TOMLS[@]}"; do
  row=$(_read_info_toml "${info_toml}") || row=""
  if [ -z "${row}" ]; then
    local_name=$(basename "$(dirname "${info_toml}")")
    row="${local_name}|${local_name}|—|—|—|"
  fi

  # Parse pipe-delimited fields: project|name|branch|title|added_at|svcs
  IFS='|' read -r f_project f_name f_branch _f_title f_added_at f_svcs <<< "${row}"

  # Look up gateway status by composite key <project>-<name>
  local_key="${f_project}-${f_name}"
  gw_status="—"
  if [ -n "${GATEWAY_JSON}" ] && [ "${GATEWAY_JSON}" != "[]" ]; then
    gw_status=$(python3 -c "
import sys, json
data = json.loads(sys.argv[1])
key = sys.argv[2]
for f in data:
    fkey = f.get('key') or (f.get('project','') + '-' + f.get('name',''))
    if fkey == key:
        print(f.get('status') or '—')
        sys.exit(0)
print('—')
" "${GATEWAY_JSON}" "${local_key}" 2>/dev/null) || gw_status="—"
  fi

  ROWS+=( "${f_name}|${f_project}|${f_branch}|${gw_status}|${f_svcs}|${f_added_at}" )
done

# ─── JSON output ─────────────────────────────────────────────────────────────
if [ "${JSON_MODE}" = true ]; then
  python3 - "${ROWS[@]}" <<'PYEOF'
import sys, json

rows = sys.argv[1:]
out = []
for r in rows:
    parts = r.split("|", 5)
    while len(parts) < 6:
        parts.append("")
    name, project, branch, status, services_raw, added_at = parts
    svcs = []
    if services_raw:
        for pair in services_raw.split(","):
            if ":" in pair:
                sn, sp = pair.split(":", 1)
                svcs.append({"name": sn, "port": sp})
            elif pair:
                svcs.append({"name": pair, "port": ""})
    out.append({
        "name": name,
        "project": project,
        "branch": branch,
        "status": status,
        "services": svcs,
        "added_at": added_at,
    })
print(json.dumps(out, indent=2))
PYEOF
  exit 0
fi

# ─── Human table output (two-pass, auto-sized columns) ───────────────────────

HDR_NAME="NAME"
HDR_PROJECT="PROJECT"
HDR_BRANCH="BRANCH"
HDR_STATUS="STATUS"
HDR_SERVICES="SERVICES"
HDR_ADDED="ADDED"

W_NAME=${#HDR_NAME}
W_PROJECT=${#HDR_PROJECT}
W_BRANCH=${#HDR_BRANCH}
W_STATUS=${#HDR_STATUS}
W_SERVICES=${#HDR_SERVICES}
W_ADDED=${#HDR_ADDED}

_truncate() {
  local s="$1" maxlen="${2:-30}"
  if [ "${#s}" -gt "${maxlen}" ]; then
    printf '%s\xe2\x80\xa6' "${s:0:$(( maxlen - 1 ))}"
  else
    printf '%s' "${s}"
  fi
}

_max() { [ "$1" -gt "$2" ] && echo "$1" || echo "$2"; }

# Pass 1: measure truncated widths
declare -a T_NAMES=()
declare -a T_PROJECTS=()
declare -a T_BRANCHES=()
declare -a T_STATUSES=()
declare -a T_SVCS=()
declare -a T_ADDEDS=()

for row in "${ROWS[@]}"; do
  IFS='|' read -r r_name r_project r_branch r_status r_svcs r_added <<< "${row}"
  t_name=$(_truncate "${r_name}" 30)
  t_project=$(_truncate "${r_project}" 20)
  t_branch=$(_truncate "${r_branch}" 25)
  t_svcs=$(_truncate "${r_svcs}" 40)
  T_NAMES+=( "${t_name}" )
  T_PROJECTS+=( "${t_project}" )
  T_BRANCHES+=( "${t_branch}" )
  T_STATUSES+=( "${r_status}" )
  T_SVCS+=( "${t_svcs}" )
  T_ADDEDS+=( "${r_added}" )
  W_NAME=$(_max "${W_NAME}" "${#t_name}")
  W_PROJECT=$(_max "${W_PROJECT}" "${#t_project}")
  W_BRANCH=$(_max "${W_BRANCH}" "${#t_branch}")
  W_STATUS=$(_max "${W_STATUS}" "${#r_status}")
  W_SERVICES=$(_max "${W_SERVICES}" "${#t_svcs}")
  W_ADDED=$(_max "${W_ADDED}" "${#r_added}")
done

# Print header
echo ""
printf "%-${W_NAME}s  %-${W_PROJECT}s  %-${W_BRANCH}s  %-${W_STATUS}s  %-${W_SERVICES}s  %s\n" \
  "${HDR_NAME}" "${HDR_PROJECT}" "${HDR_BRANCH}" "${HDR_STATUS}" "${HDR_SERVICES}" "${HDR_ADDED}"

# Separator
SEP=$(printf '%0.s─' $(seq 1 $(( W_NAME + 2 + W_PROJECT + 2 + W_BRANCH + 2 + W_STATUS + 2 + W_SERVICES + 2 + W_ADDED )) ))
echo "${SEP}"

# Pass 2: print rows
for i in "${!ROWS[@]}"; do
  t_name="${T_NAMES[$i]}"
  t_project="${T_PROJECTS[$i]}"
  t_branch="${T_BRANCHES[$i]}"
  r_status="${T_STATUSES[$i]}"
  t_svcs="${T_SVCS[$i]}"
  r_added="${T_ADDEDS[$i]}"

  # Colour status (only when writing to a tty)
  case "${r_status}" in
    up)       status_display="${GREEN}${r_status}${RESET}" ;;
    down)     status_display="${RED}${r_status}${RESET}" ;;
    building|starting) status_display="${YELLOW}${r_status}${RESET}" ;;
    *)        status_display="${r_status}" ;;
  esac

  # The status column has colour escapes which inflate the byte length.
  # Print the fixed-width prefix columns first, then status (with colour),
  # then pad manually to keep subsequent columns aligned.
  printf "%-${W_NAME}s  %-${W_PROJECT}s  %-${W_BRANCH}s  " \
    "${t_name}" "${t_project}" "${t_branch}"
  printf "%b" "${status_display}"
  # Pad to W_STATUS using the plain (no-escape) length of r_status
  pad=$(( W_STATUS - ${#r_status} ))
  if [ "${pad}" -gt 0 ]; then
    printf '%*s' "${pad}" ''
  fi
  printf "  %-${W_SERVICES}s  %s\n" "${t_svcs}" "${r_added}"
done

echo ""
