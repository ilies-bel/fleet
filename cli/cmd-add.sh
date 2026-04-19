#!/bin/bash
set -euo pipefail

# ─── Resolve paths ───────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLEET_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
export FLEET_ROOT

# Source shared library
# shellcheck source=./common.sh
source "${SCRIPT_DIR}/common.sh"

# ─── Usage ───────────────────────────────────────────────────────────────────
usage() {
  echo "Usage: fleet add <name> [--service <svc>=<path>:<image> ...]"
  echo ""
  echo "  name                     Feature name (lowercase letters, numbers, hyphens)"
  echo "  --service svc=path:image Override path and image for a named service."
  echo "                           Repeat for each service you want. If omitted,"
  echo "                           all services from fleet.toml are spun up."
  echo ""
  echo "Examples:"
  echo "  fleet add my-feature"
  echo "  fleet add only-be --service backend=./d2r2-backend:fleet-feature-base"
  exit 1
}

# ─── _parse_service_override "svcName=<path>:<image>" ────────────────────────
# Must be defined before the arg-parsing loop that calls it.
# Appends to _SVC_NAMES, _SVC_PATHS, _SVC_IMAGES on success; returns 1 on bad format.
_parse_service_override() {
  local raw="$1"
  # Split on FIRST '=' to isolate svc_name from path:image
  local svc_name="${raw%%=*}"
  local rest="${raw#*=}"
  # Guard: no '=' found, or empty name
  [ -z "$svc_name" ] && return 1
  [ "$svc_name" = "$raw" ] && return 1

  # Split on LAST ':' — image tags contain ':', paths should not
  local path="${rest%:*}"
  local image="${rest##*:}"
  # Guard: no ':' found, or empty path/image
  [ -z "$path" ]  && return 1
  [ -z "$image" ] && return 1
  [ "$path" = "$rest" ] && return 1

  _SVC_NAMES+=("$svc_name")
  _SVC_PATHS+=("$path")
  _SVC_IMAGES+=("$image")
  return 0
}

# ─── Args ────────────────────────────────────────────────────────────────────
if [ -z "${1:-}" ]; then
  usage
fi

NAME="$1"
shift

validate_feature_name "${NAME}"

# Parallel arrays for --service overrides
declare -a _SVC_NAMES=()
declare -a _SVC_PATHS=()
declare -a _SVC_IMAGES=()

while [ $# -gt 0 ]; do
  case "$1" in
    --service)
      shift
      [ -z "${1:-}" ] && error "--service requires an argument: svc=<path>:<image>"
      _parse_service_override "$1" \
        || error "Invalid --service format '$1': expected svc=<path>:<image>"
      shift
      ;;
    --service=*)
      _parse_service_override "${1#--service=}" \
        || error "Invalid --service format '${1#--service=}': expected svc=<path>:<image>"
      shift
      ;;
    *)
      error "Unknown argument: $1"
      ;;
  esac
done

# ─── Load fleet.toml ─────────────────────────────────────────────────────────
load_fleet_toml

_PYBIN=$(_find_python_with_tomllib) \
  || error "No python3 with tomllib/tomli found. Install python >=3.11 or: pip3 install tomli"

# ─── Guard: duplicate feature ────────────────────────────────────────────────
FEATURE_DIR="${FLEET_ROOT}/.fleet/${NAME}"
INFO_TOML="${FEATURE_DIR}/info.toml"

if [ -f "${INFO_TOML}" ]; then
  error "Feature '${NAME}' already exists (.fleet/${NAME}/info.toml). Run: fleet rm ${NAME}"
fi

# ─── _svc_field <json> <svc_name> <field> ────────────────────────────────────
# Prints the value of <field> for the service named <svc_name> in <json>.
# Prints empty string if service or field not found. Never fails.
_svc_field() {
  "$_PYBIN" -c "
import sys, json
services = json.loads(sys.argv[1])
name  = sys.argv[2]
field = sys.argv[3]
for s in services:
    if s.get('name') == name:
        print(s.get(field, ''))
        raise SystemExit(0)
print('')
" "$1" "$2" "$3" 2>/dev/null || true
}

# ─── Build effective service list ────────────────────────────────────────────
# Each entry is a pipe-delimited string: name|abs_path|image|stack|build|run|port
# Using a pipe delimiter because all fields can contain spaces except image names.

declare -a EFFECTIVE_SERVICES=()

if [ "${#_SVC_NAMES[@]}" -gt 0 ]; then
  # --service overrides: only the named services, with caller-supplied path/image
  for i in "${!_SVC_NAMES[@]}"; do
    ov_svc="${_SVC_NAMES[$i]}"
    ov_path="${_SVC_PATHS[$i]}"
    ov_image="${_SVC_IMAGES[$i]}"

    ov_abs_path="$(cd "${ov_path}" 2>/dev/null && pwd)" \
      || error "Service '${ov_svc}': path '${ov_path}' does not exist on disk"

    ov_stack=$(_svc_field "${FLEET_SERVICES_JSON}" "${ov_svc}" "stack")
    ov_build=$(_svc_field "${FLEET_SERVICES_JSON}" "${ov_svc}" "build")
    ov_run=$(  _svc_field "${FLEET_SERVICES_JSON}" "${ov_svc}" "run")
    ov_port=$( _svc_field "${FLEET_SERVICES_JSON}" "${ov_svc}" "port")

    EFFECTIVE_SERVICES+=("${ov_svc}|${ov_abs_path}|${ov_image}|${ov_stack}|${ov_build}|${ov_run}|${ov_port}")
  done
else
  # Default: all services from fleet.toml
  svc_count=$("$_PYBIN" -c "import sys,json; print(len(json.loads(sys.argv[1])))" "${FLEET_SERVICES_JSON}")
  if [ "${svc_count}" -eq 0 ]; then
    error "No [[services]] defined in .fleet/fleet.toml. Run: fleet init"
  fi

  for idx in $(seq 0 $((svc_count - 1))); do
    _at() { "$_PYBIN" -c "import sys,json; a=json.loads(sys.argv[1]); print(a[int(sys.argv[2])].get(sys.argv[3],''))" "${FLEET_SERVICES_JSON}" "$idx" "$1"; }

    svc_name=$(_at name)
    svc_dir=$(  _at dir)
    svc_stack=$(_at stack)
    svc_build=$(_at build)
    svc_run=$(  _at run)
    svc_port=$( _at port)

    svc_image="fleet-feature-base"
    svc_abs_path="${FLEET_PROJECT_ROOT}/${svc_dir}"

    [ -d "${svc_abs_path}" ] \
      || error "Service '${svc_name}': '${svc_abs_path}' does not exist. Check project.root in .fleet/fleet.toml."

    EFFECTIVE_SERVICES+=("${svc_name}|${svc_abs_path}|${svc_image}|${svc_stack}|${svc_build}|${svc_run}|${svc_port}")
  done
fi

[ "${#EFFECTIVE_SERVICES[@]}" -gt 0 ] \
  || error "No services resolved. Check --service arguments or [[services]] in .fleet/fleet.toml."

# ─── Resolve branch per service path ─────────────────────────────────────────
declare -a SVC_BRANCHES=()

for entry in "${EFFECTIVE_SERVICES[@]}"; do
  IFS='|' read -r _nm _path _img _st _bld _run _port <<< "$entry"
  branch=$(git -C "${_path}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
  # Detached HEAD → normalize to "main"
  [ "${branch}" = "HEAD" ] && branch="main"
  SVC_BRANCHES+=("${branch}")
done

# ─── Load shared mounts from .fleet/shared.env ───────────────────────────────
SHARED_ENV_FILE="${FLEET_ROOT}/.fleet/shared.env"
declare -a SHARED_MOUNTS=()

if [ -f "${SHARED_ENV_FILE}" ]; then
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    [[ "$line" == \#* ]] && continue
    src="${FLEET_PROJECT_ROOT}/${line}"
    if [ -e "$src" ]; then
      SHARED_MOUNTS+=("${src}:/app/${line}:ro")
    else
      warn "shared.env: '${line}' not found at '${src}', skipping"
    fi
  done < "${SHARED_ENV_FILE}"
fi

# ─── Decide whether to provision a Postgres sidecar ──────────────────────────
# Spring / Gradle services almost always need a relational DB at startup
# (Liquibase/Flyway migrations, JPA/jOOQ wiring). Provision a dedicated postgres
# container per feature so migrations have somewhere to run without reaching
# out to the host's `localhost:5432`. Credentials default to the project name;
# override via DB_NAME / DB_USER / DB_PASSWORD env vars on the fleet caller's
# shell (e.g. through .fleet/shared.env).
NEEDS_DB=false
for _entry in "${EFFECTIVE_SERVICES[@]}"; do
  IFS='|' read -r _nm _path _img _st _bld _run _port <<< "${_entry}"
  case "${_st}" in spring|gradle) NEEDS_DB=true ;; esac
done

SIDECAR_DB_NAME="${DB_NAME:-${FLEET_PROJECT_NAME}}"
SIDECAR_DB_USER="${DB_USER:-${FLEET_PROJECT_NAME}}"
SIDECAR_DB_PASSWORD="${DB_PASSWORD:-${FLEET_PROJECT_NAME}}"
SIDECAR_DB_HOST="postgres"   # reachable via compose service DNS on fleet-net

# ─── Generate docker-compose.yml ─────────────────────────────────────────────
info "Generating .fleet/${NAME}/docker-compose.yml..."
mkdir -p "${FEATURE_DIR}"
COMPOSE_FILE="${FEATURE_DIR}/docker-compose.yml"

# Only the first service (fleet.toml order) gets a host port binding.
# All others are reachable via container DNS on fleet-net only.
_first_svc=true

{
  echo "services:"

  # Postgres sidecar (emitted first so it's ready before JVM services connect)
  if [ "${NEEDS_DB}" = true ]; then
    echo "  postgres:"
    echo "    image: postgres:16-alpine"
    echo "    container_name: fleet-${NAME}-postgres"
    echo "    environment:"
    echo "      - POSTGRES_DB=${SIDECAR_DB_NAME}"
    echo "      - POSTGRES_USER=${SIDECAR_DB_USER}"
    echo "      - POSTGRES_PASSWORD=${SIDECAR_DB_PASSWORD}"
    echo "    volumes:"
    echo "      - fleet-${NAME}-pgdata:/var/lib/postgresql/data"
    echo "    networks:"
    echo "      - fleet-net"
    echo "    healthcheck:"
    echo "      test: [\"CMD-SHELL\", \"pg_isready -U ${SIDECAR_DB_USER} -d ${SIDECAR_DB_NAME}\"]"
    echo "      interval: 5s"
    echo "      timeout: 5s"
    echo "      retries: 10"
    echo ""
  fi

  for i in "${!EFFECTIVE_SERVICES[@]}"; do
    IFS='|' read -r svc_nm svc_path svc_img svc_stack svc_build svc_run svc_port <<< "${EFFECTIVE_SERVICES[$i]}"
    svc_branch="${SVC_BRANCHES[$i]}"

    echo "  ${NAME}-${svc_nm}:"
    echo "    image: ${svc_img}"
    echo "    container_name: fleet-${NAME}-${svc_nm}"

    # Feature containers are internal — accessed via gateway proxy over fleet-net.
    # No host port binding; avoids collisions with the gateway's own :3000/:4000.

    echo "    environment:"
    echo "      - APP_NAME=${NAME}-${svc_nm}"
    echo "      - BRANCH=${svc_branch}"
    echo "      - PROJECT_NAME=${FLEET_PROJECT_NAME}"
    [ -n "${svc_build}" ]       && echo "      - BACKEND_BUILD_CMD=${svc_build}"
    [ -n "${svc_run}" ]         && echo "      - BACKEND_RUN_CMD=${svc_run}"
    [ -n "${svc_port}" ]        && echo "      - BACKEND_PORT=${svc_port}"
    [ -n "${FLEET_PORT_DB}" ]   && echo "      - DB_PORT=${FLEET_PORT_DB}"
    [ -n "${DB_NAME:-}" ]       && echo "      - DB_NAME=${DB_NAME}"
    [ -n "${DB_USER:-}" ]       && echo "      - DB_USER=${DB_USER}"
    [ -n "${DB_PASSWORD:-}" ]   && echo "      - DB_PASSWORD=${DB_PASSWORD}"
    [ -n "${DB_NAME:-}" ]       && echo "      - DB_HOST=127.0.0.1"
    [ -n "${JWT_SECRET:-}" ]    && echo "      - JWT_SECRET=${JWT_SECRET}"
    [ -n "${JWT_ISSUER:-}" ]    && echo "      - JWT_ISSUER=${JWT_ISSUER}"
    # Testcontainers host override: from inside a container on fleet-net, the
    # host's 'localhost' is not reachable. Spawned Testcontainers (Ryuk + fixtures)
    # bind ports on the Docker host; point clients at host.docker.internal so the
    # build container can reach them. Docker Desktop (macOS/Windows) auto-resolves
    # this hostname; on Linux, configure --add-host at daemon level.
    case "${svc_stack}" in
      spring|gradle)
        echo "      - TESTCONTAINERS_HOST_OVERRIDE=host.docker.internal"
        # Point Spring Boot at the postgres sidecar. Env vars are higher priority
        # than profile-packaged application-<profile>.yml (Boot property source
        # order #10 > #13), so this beats any hardcoded localhost:5432 in the jar.
        if [ "${NEEDS_DB}" = true ]; then
          echo "      - SPRING_DATASOURCE_URL=jdbc:postgresql://${SIDECAR_DB_HOST}:5432/${SIDECAR_DB_NAME}"
          echo "      - SPRING_DATASOURCE_USERNAME=${SIDECAR_DB_USER}"
          echo "      - SPRING_DATASOURCE_PASSWORD=${SIDECAR_DB_PASSWORD}"
          echo "      - SPRING_LIQUIBASE_URL=jdbc:postgresql://${SIDECAR_DB_HOST}:5432/${SIDECAR_DB_NAME}"
          echo "      - SPRING_LIQUIBASE_USER=${SIDECAR_DB_USER}"
          echo "      - SPRING_LIQUIBASE_PASSWORD=${SIDECAR_DB_PASSWORD}"
        fi
        ;;
    esac
    # JVM stacks often use Testcontainers for integration-test / codegen workflows
    # (e.g. jOOQ-codegen backed by a throw-away Postgres). Mount the host Docker
    # socket so Testcontainers can launch sibling containers, and disable SELinux
    # labeling so the container user can actually access the socket node.
    # Security trade-off accepted for local dev; do NOT ship this to shared infra.
    case "${svc_stack}" in
      spring|gradle)
        echo "    security_opt:"
        echo "      - label:disable"
        ;;
    esac
    echo "    volumes:"
    echo "      - ${svc_path}:/app:cached"
    case "${svc_stack}" in
      spring|gradle)
        echo "      - /var/run/docker.sock:/var/run/docker.sock"
        ;;
    esac
    if [ "${#SHARED_MOUNTS[@]}" -gt 0 ]; then
      for mount in "${SHARED_MOUNTS[@]}"; do
        echo "      - ${mount}"
      done
    fi
    echo "    networks:"
    echo "      - fleet-net"
    # Wait for postgres to be healthy before the JVM service starts. Harmless
    # for non-DB services because they still get scheduled concurrently; only
    # the service-healthy gate adds at most the postgres readiness delay.
    if [ "${NEEDS_DB}" = true ]; then
      case "${svc_stack}" in
        spring|gradle)
          echo "    depends_on:"
          echo "      postgres:"
          echo "        condition: service_healthy"
          ;;
      esac
    fi
    # Note: Docker Desktop (macOS/Windows) auto-resolves host.docker.internal.
    # On native Linux, users must configure --add-host=host.docker.internal:host-gateway
    # at daemon level (via daemon.json) — fleet does not inject extra_hosts here
    # because some Docker setups reject the host-gateway sentinel.
    echo ""
  done

  echo "networks:"
  echo "  fleet-net:"
  echo "    external: true"

  # Named volume for the postgres sidecar's data directory.
  if [ "${NEEDS_DB}" = true ]; then
    echo ""
    echo "volumes:"
    echo "  fleet-${NAME}-pgdata:"
  fi
} > "${COMPOSE_FILE}"

# ─── Write .fleet/<name>/info.toml ───────────────────────────────────────────
info "Writing .fleet/${NAME}/info.toml..."

{
  echo "[feature]"
  echo "name    = \"${NAME}\""
  echo "project = \"${FLEET_PROJECT_NAME}\""
  echo ""

  for i in "${!EFFECTIVE_SERVICES[@]}"; do
    IFS='|' read -r svc_nm svc_path svc_img svc_stack svc_build svc_run svc_port <<< "${EFFECTIVE_SERVICES[$i]}"
    svc_branch="${SVC_BRANCHES[$i]}"
    echo "[[services]]"
    echo "name   = \"${svc_nm}\""
    echo "dir    = \"${svc_path}\""
    echo "image  = \"${svc_img}\""
    echo "branch = \"${svc_branch}\""
    [ -n "${svc_stack}" ] && echo "stack  = \"${svc_stack}\""
    [ -n "${svc_port}" ]  && echo "port   = ${svc_port}"
    echo ""
  done
} > "${INFO_TOML}"

# ─── Bring up containers ─────────────────────────────────────────────────────
info "Starting containers for '${NAME}'..."
docker compose -f "${COMPOSE_FILE}" up -d

# ─── Register with gateway ───────────────────────────────────────────────────
# Payload contract: {name, branch, worktreePath, project, services:[{name,port}]}
# branch = git HEAD of first service (representative for the feature)
# services = list used by the gateway proxy to route /<svc>/... path prefixes.
FIRST_BRANCH="${SVC_BRANCHES[0]}"

# Build the services JSON array (comma-separated {name, port} objects).
services_json=""
for i in "${!EFFECTIVE_SERVICES[@]}"; do
  IFS='|' read -r _svc_nm _svc_path _svc_img _svc_stack _svc_bld _svc_run _svc_port <<< "${EFFECTIVE_SERVICES[$i]}"
  [ -z "${_svc_port}" ] && continue
  [ -n "${services_json}" ] && services_json="${services_json},"
  services_json="${services_json}{\"name\":\"${_svc_nm}\",\"port\":${_svc_port}}"
done

info "Registering '${NAME}' with gateway..."
HTTP_STATUS=$(gateway_post "register-feature" \
  "{\"name\":\"${NAME}\",\"branch\":\"${FIRST_BRANCH}\",\"worktreePath\":\"${FLEET_PROJECT_ROOT}\",\"project\":\"${FLEET_PROJECT_NAME}\",\"services\":[${services_json}]}")

if [ "${HTTP_STATUS}" != "200" ]; then
  warn "Gateway registration returned HTTP ${HTTP_STATUS} (is the gateway running?)"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}┌──────────────────────────────────────────────────────────────┐${RESET}"
echo -e "${GREEN}│  '${NAME}' started (${#EFFECTIVE_SERVICES[@]} service(s))${RESET}"
for i in "${!EFFECTIVE_SERVICES[@]}"; do
  IFS='|' read -r svc_nm svc_path svc_img _ _ _ _ <<< "${EFFECTIVE_SERVICES[$i]}"
  echo -e "${GREEN}│    fleet-${NAME}-${svc_nm}  image=${svc_img}${RESET}"
done
echo -e "${GREEN}│  Proxy  → http://localhost:${FLEET_PORT_PROXY}${RESET}"
echo -e "${GREEN}│  Logs   → docker compose -f .fleet/${NAME}/docker-compose.yml logs -f${RESET}"
echo -e "${GREEN}└──────────────────────────────────────────────────────────────┘${RESET}"
