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

# ─── Push each service ───────────────────────────────────────────────────────
PUSHED=0

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

  remote_branch=$(git -C "${svc_dir}" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || echo "")

  if [ -n "${remote_branch}" ]; then
    info "Pushing '${svc_name}' (${svc_dir}, branch: ${svc_branch})..."
    git -C "${svc_dir}" push
  else
    info "Pushing '${svc_name}' (${svc_dir}, branch: ${svc_branch}, setting upstream)..."
    git -C "${svc_dir}" push --set-upstream origin "${svc_branch}"
  fi

  PUSHED=$((PUSHED + 1))
done <<< "${_SVC_ENTRIES}"

if [ "${PUSHED}" -eq 0 ]; then
  error "No repos pushed — check service directories in .fleet/${NAME}/info.toml"
fi

info "Pushed ${PUSHED} repo(s)."
