#!/bin/bash
set -euo pipefail

# ─── Resolve paths ───────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLEET_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
export FLEET_ROOT

# Source shared library
# shellcheck source=./common.sh
source "${SCRIPT_DIR}/common.sh"

NAME="${1:-}"
if [ "${NAME}" = "--help" ] || [ "${NAME}" = "-h" ]; then
  echo ""
  echo -e "${GREEN}fleet push${RESET} — push service branches to remote"
  echo ""
  echo "Usage: fleet push <name>"
  echo ""
  echo "Arguments:"
  echo -e "  ${BLUE}<name>${RESET}   Feature name (must have an active .fleet/<name>/info.toml)"
  echo ""
  echo "  Reads each service's repo dir and branch from info.toml, then"
  echo "  runs 'git push' (setting upstream on the first push if needed)."
  echo ""
  echo "  Failed pushes are queued in .fleet/push-pending.txt and auto-retried"
  echo "  on the next 'fleet push <name>' once your network/VPN is up."
  echo ""
  echo "Examples:"
  echo "  fleet push my-feature"
  echo "  fleet push qa-main"
  echo ""
  exit 0
fi
if [ -z "$NAME" ]; then
  echo "Usage: fleet push <feature-name>"
  exit 1
fi

validate_feature_name "${NAME}"

# Resolve per-project .fleet/ root
load_fleet_toml

INFO_TOML="${FLEET_CONFIG_ROOT}/.fleet/${NAME}/info.toml"
[ -f "${INFO_TOML}" ] || error "Feature '${NAME}' not found (no .fleet/${NAME}/info.toml). Run: fleet add ${NAME}"

# ─── Pending file path ───────────────────────────────────────────────────────
PENDING_FILE="${FLEET_CONFIG_ROOT}/.fleet/push-pending.txt"

# _pending_append FEATURE SVC_NAME SVC_DIR SVC_BRANCH
# Appends a pipe-delimited entry to push-pending.txt (dedup on exact line).
# Creates the file lazily — never creates an empty file.
_pending_append() {
  local line="${1}|${2}|${3}|${4}"
  if [ -f "${PENDING_FILE}" ] && grep -qxF "${line}" "${PENDING_FILE}" 2>/dev/null; then
    return 0  # already queued, do not duplicate
  fi
  printf '%s\n' "${line}" >> "${PENDING_FILE}"
}

# _pending_remove FEATURE SVC_NAME SVC_DIR SVC_BRANCH
# Removes the exact matching line from push-pending.txt atomically.
# No-op if the file does not exist or the line is absent.
_pending_remove() {
  local line="${1}|${2}|${3}|${4}"
  [ -f "${PENDING_FILE}" ] || return 0
  local tmp
  tmp=$(mktemp "${PENDING_FILE}.XXXXXX")
  grep -vxF "${line}" "${PENDING_FILE}" > "${tmp}" 2>/dev/null || true
  mv -f "${tmp}" "${PENDING_FILE}"
  # If file is now empty, remove it to keep things tidy (optional, not required).
  # We leave the empty file in place to avoid subtle TOCTOU issues with parallel
  # pushes; the retry phase simply skips it when empty.
}

# _do_push SVC_NAME SVC_DIR SVC_BRANCH
# Performs the actual git push (with or without --set-upstream).
# Returns 0 on success, non-zero on failure.
# Must be called with set -e temporarily suspended OR inside `if !` / `|| {`.
_do_push() {
  local svc_name="${1}" svc_dir="${2}" svc_branch="${3}"
  local remote_branch
  remote_branch=$(git -C "${svc_dir}" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)

  if [ -n "${remote_branch}" ]; then
    info "Pushing '${svc_name}' (${svc_dir}, branch: ${svc_branch})..."
    git -C "${svc_dir}" push
  else
    info "Pushing '${svc_name}' (${svc_dir}, branch: ${svc_branch}, setting upstream)..."
    git -C "${svc_dir}" push --set-upstream origin "${svc_branch}"
  fi
}

# ─── Parse services from info.toml ───────────────────────────────────────────
_PYBIN=$(_find_python_with_tomllib) \
  || error "No python3 with tomllib/tomli found. Install python >=3.11 or: pip3 install tomli"

# Read service entries as newline-separated "name|dir|branch" triples
_SVC_ENTRIES=$("$_PYBIN" - "${INFO_TOML}" <<'PYEOF'
import sys
try:
    import tomllib
except ModuleNotFoundError:
    import tomli as tomllib

with open(sys.argv[1], "rb") as fh:
    data = tomllib.load(fh)

for svc in data.get("services", []):
    name   = svc.get("name", "")
    dirval = svc.get("dir", "")
    branch = svc.get("branch", "")
    if name and dirval:
        print(f"{name}|{dirval}|{branch}")
PYEOF
)

if [ -z "${_SVC_ENTRIES}" ]; then
  error "No services found in .fleet/${NAME}/info.toml. Run: fleet add ${NAME}"
fi

# ─── Counters ────────────────────────────────────────────────────────────────
PUSHED=0
RETRIED=0
QUEUED=0

# ─── Retry-first phase ───────────────────────────────────────────────────────
# If push-pending.txt exists, attempt to retry entries for this feature first.
if [ -f "${PENDING_FILE}" ]; then
  # Feature name validation regex (matches validate_feature_name in common.sh)
  _VALID_NAME_RE='^[a-z0-9]([a-z0-9-]*(\.[a-z0-9-]+)*)?$'

  while IFS= read -r pending_line || [ -n "${pending_line}" ]; do
    [ -z "${pending_line}" ] && continue

    # Parse the four pipe-delimited fields
    IFS='|' read -r p_feat p_svc p_dir p_branch <<< "${pending_line}"

    # Only process entries for the current feature
    [ "${p_feat}" = "${NAME}" ] || continue

    # Validate the stored feature name defensively (corrupt file guard)
    if ! echo "${p_feat}" | grep -qE "${_VALID_NAME_RE}"; then
      warn "push-pending.txt: skipping corrupt entry with invalid feature name '${p_feat}'"
      continue
    fi

    # Validate the directory exists and is a git repo before retrying
    if [ ! -d "${p_dir}" ]; then
      warn "Retry: service '${p_svc}': directory '${p_dir}' not found — leaving queued"
      continue
    fi
    if ! git -C "${p_dir}" rev-parse --git-dir >/dev/null 2>&1; then
      warn "Retry: service '${p_svc}': '${p_dir}' is not a git repository — leaving queued"
      continue
    fi

    if _do_push "${p_svc}" "${p_dir}" "${p_branch}"; then
      info "Retry succeeded for '${p_svc}' — removing from pending queue"
      _pending_remove "${p_feat}" "${p_svc}" "${p_dir}" "${p_branch}"
      RETRIED=$((RETRIED + 1))
    else
      warn "Retry failed for '${p_svc}' — still queued"
    fi
  done < "${PENDING_FILE}"
fi

# ─── Main push loop ──────────────────────────────────────────────────────────
while IFS= read -r entry; do
  [ -z "${entry}" ] && continue

  IFS='|' read -r svc_name svc_dir svc_branch <<< "${entry}"

  if [ ! -d "${svc_dir}" ]; then
    warn "Service '${svc_name}': directory '${svc_dir}' not found — skipping"
    continue
  fi

  if ! git -C "${svc_dir}" rev-parse --git-dir >/dev/null 2>&1; then
    warn "Service '${svc_name}': '${svc_dir}' is not a git repository — skipping"
    continue
  fi

  if _do_push "${svc_name}" "${svc_dir}" "${svc_branch}"; then
    PUSHED=$((PUSHED + 1))
    # If this service had a previously queued entry (re-pushed via normal path),
    # remove it from the pending file now that it succeeded.
    _pending_remove "${NAME}" "${svc_name}" "${svc_dir}" "${svc_branch}"
  else
    warn "Push failed for '${svc_name}' — queuing for retry"
    _pending_append "${NAME}" "${svc_name}" "${svc_dir}" "${svc_branch}"
    QUEUED=$((QUEUED + 1))
  fi
done <<< "${_SVC_ENTRIES}"

# ─── Compute still-pending count for this feature ────────────────────────────
STILL_PENDING=0
if [ -f "${PENDING_FILE}" ]; then
  # Count lines in the file that belong to NAME
  while IFS= read -r pl || [ -n "${pl}" ]; do
    [ -z "${pl}" ] && continue
    IFS='|' read -r _pf _rest <<< "${pl}"
    [ "${_pf}" = "${NAME}" ] && STILL_PENDING=$((STILL_PENDING + 1))
  done < "${PENDING_FILE}"
fi

# ─── Guard: nothing was done at all ──────────────────────────────────────────
# Only fire when we pushed nothing, retried nothing, and queued nothing —
# meaning info.toml had no valid services at all (not a partial-failure run).
if [ "${PUSHED}" -eq 0 ] && [ "${RETRIED}" -eq 0 ] && [ "${QUEUED}" -eq 0 ]; then
  error "No repos pushed — check service directories in .fleet/${NAME}/info.toml"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
info "Pushed ${PUSHED} | Retried-OK ${RETRIED} | Queued ${QUEUED} | Still-pending-for-this-feature ${STILL_PENDING}"

if [ "${STILL_PENDING}" -gt 0 ]; then
  warn "Run 'fleet push ${NAME}' again once your network/VPN is up."
  exit 1
fi
