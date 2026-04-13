#!/bin/bash
set -e

# ── Config injected by docker-compose (sourced from qa-fleet.conf) ────────────
APP_NAME="${APP_NAME:-qa-feature}"
BRANCH="${BRANCH:?BRANCH env var is required}"
FRONTEND_DIR="${FRONTEND_DIR:?FRONTEND_DIR env var is required}"
FRONTEND_OUT_DIR="${FRONTEND_OUT_DIR:-out}"
BACKEND_DIR="${BACKEND_DIR:-}"
BACKEND_BUILD_CMD="${BACKEND_BUILD_CMD:-}"
BACKEND_ARTIFACT_PATH="${BACKEND_ARTIFACT_PATH:-/home/developer/backend.jar}"
BACKEND_RUN_CMD="${BACKEND_RUN_CMD:-java -jar ${BACKEND_ARTIFACT_PATH}}"
BACKEND_PORT="${BACKEND_PORT:-8081}"
DB_NAME="${DB_NAME:-}"
DB_USER="${DB_USER:-}"
DB_PASSWORD="${DB_PASSWORD:-}"
DB_PORT="${DB_PORT:-5432}"
PROXY_PORT="${PROXY_PORT:-3000}"
JWT_SECRET="${JWT_SECRET:-}"
JWT_ISSUER="${JWT_ISSUER:-myapp}"

# Source backend .env overrides if mounted via .qa-shared.
# .env is allowed to override application-level config (LDAP, JWT, business config),
# but DB_HOST and DB_PORT must always point at container-internal postgres — otherwise
# the host's dev-oriented values (e.g. localhost:5433) clobber the truth (127.0.0.1:5432)
# and the backend never connects.
if [ -n "${BACKEND_DIR}" ] && [ -f "/app/${BACKEND_DIR}/.env" ]; then
  echo "[qa] Loading backend .env overrides from /app/${BACKEND_DIR}/.env..."
  _qa_orig_db_host="${DB_HOST:-}"
  _qa_orig_db_port="${DB_PORT:-}"
  set -a
  # shellcheck source=/dev/null
  source "/app/${BACKEND_DIR}/.env"
  set +a
  if [ "${DB_HOST:-}" != "127.0.0.1" ] || [ "${DB_PORT:-}" != "5432" ]; then
    echo "[qa] .env tried to set DB_HOST=${DB_HOST:-unset} DB_PORT=${DB_PORT:-unset} — forcing container-internal 127.0.0.1:5432"
  fi
  DB_HOST=127.0.0.1
  DB_PORT=5432
  export DB_HOST DB_PORT
  unset _qa_orig_db_host _qa_orig_db_port
fi

PG_DATA="/var/lib/postgresql/16/main"
SENTINEL="/tmp/.qa-built"

echo "[qa] ============================================================"
echo "[qa] Feature:  ${APP_NAME}  |  Branch: ${BRANCH}"
echo "[qa] Frontend: ${FRONTEND_DIR} (out: ${FRONTEND_OUT_DIR})"
echo "[qa] Backend:  ${BACKEND_DIR:-none}"
echo "[qa] Database: ${DB_NAME:-disabled}"
echo "[qa] ============================================================"

if [ ! -f "${SENTINEL}" ]; then
  # ── 1. Seed node_modules from host copy ──────────────────────────────────────
  if [ ! -d "/app/${FRONTEND_DIR}/node_modules/.bin" ]; then
    echo "[qa] Seeding node_modules from host copy..."
    cp -a /app-nm-seed/. "/app/${FRONTEND_DIR}/node_modules/"
  fi

  # ── 2. Patch macOS arm64 binaries → Linux arm64 ──────────────────────────────
  # Only relevant for Next.js / Vite projects whose node_modules were installed on macOS.
  # fetch_pkg is a no-op when the darwin source package is absent, so it is safe to run
  # for any npm-based project.
  echo "[qa] Patching platform-specific npm binaries for Linux arm64..."
  cd "/app/${FRONTEND_DIR}"
  NPM_REGISTRY="https://registry.npmjs.org"
  pkg_ver() {
    python3 -c "import json; print(json.load(open('node_modules/${1}/package.json'))['version'])" 2>/dev/null || true
  }
  fetch_pkg() {
    local pkg="$1" ver="$2"
    [ -z "$ver" ] && return 0          # darwin package absent — nothing to mirror
    local dir="node_modules/${pkg}"
    [ -d "$dir" ] && return 0          # already present
    local bare="${pkg##*/}"
    echo "[qa] Fetching ${pkg}@${ver}..."
    mkdir -p "$dir"
    curl -fsSL "${NPM_REGISTRY}/${pkg}/-/${bare}-${ver}.tgz" \
      | tar -xz -C "$dir" --strip-components=1 \
      || { echo "[qa] WARN: failed to fetch ${pkg}@${ver}"; rm -rf "$dir"; }
  }
  fetch_pkg "@next/swc-linux-arm64-gnu"              "$(pkg_ver '@next/swc-darwin-arm64')"
  fetch_pkg "lightningcss-linux-arm64-gnu"            "$(pkg_ver 'lightningcss-darwin-arm64')"
  fetch_pkg "@tailwindcss/oxide-linux-arm64-gnu"      "$(pkg_ver '@tailwindcss/oxide-darwin-arm64')"
  fetch_pkg "@esbuild/linux-arm64"                    "$(pkg_ver '@esbuild/darwin-arm64')"
  fetch_pkg "@rollup/rollup-linux-arm64-gnu"          "$(pkg_ver '@rollup/rollup-darwin-arm64')"
  fetch_pkg "@oxc-resolver/binding-linux-arm64-gnu"   "$(pkg_ver '@oxc-resolver/binding-darwin-arm64')"
  fetch_pkg "@unrs/resolver-binding-linux-arm64-gnu"  "$(pkg_ver '@unrs/resolver-binding-darwin-arm64')"

  # ── 3. Build frontend ─────────────────────────────────────────────────────────
  echo "[qa] Building frontend (npm run build)..."
  cd "/app/${FRONTEND_DIR}"
  NEXT_TELEMETRY_DISABLED=1 \
  NEXT_PUBLIC_URL_BACK="__QA_BACKEND_URL__" \
  NEXT_PUBLIC_APP_URL="__QA_APP_URL__" \
  NODE_OPTIONS="--max-old-space-size=4096" \
    npm run build
  cp -a "${FRONTEND_OUT_DIR}/." /var/www/html/

  # ── 4. Patch frontend bundle URLs ────────────────────────────────────────────
  # Replaces placeholder strings injected at build time with runtime values.
  # Projects that don't use these placeholders are unaffected (sed finds no matches).
  echo "[qa] Patching frontend bundle URLs..."
  find /var/www/html -name "*.js" -exec sed -i \
    -e "s|__QA_BACKEND_URL__|/backend|g" \
    -e "s|__QA_APP_URL__|http://localhost:${PROXY_PORT}|g" \
    {} \;

  # ── 5. Build backend (if configured) ─────────────────────────────────────────
  if [ -n "${BACKEND_DIR}" ] && [ -n "${BACKEND_BUILD_CMD}" ]; then
    echo "[qa] Building backend (${BACKEND_BUILD_CMD})..."
    cd "/app/${BACKEND_DIR}"
    eval "${BACKEND_BUILD_CMD}"
    # Copy JAR to a stable path if the build produced one (Spring Boot convention).
    if ls target/*.jar >/dev/null 2>&1; then
      cp target/*.jar "${BACKEND_ARTIFACT_PATH}"
    fi
  fi

  touch "${SENTINEL}"
  echo "[qa] Build complete."
else
  echo "[qa] Sentinel found — skipping build (container restart)."
fi

# ── 6. Initialise PostgreSQL (if DB_NAME is configured) ──────────────────────
if [ -n "${DB_NAME}" ] && [ ! -f "${PG_DATA}/PG_VERSION" ]; then
  echo "[qa] First start — initialising PostgreSQL..."

  su -s /bin/bash postgres -c \
    "/usr/lib/postgresql/16/bin/initdb -D ${PG_DATA} -E UTF8 --locale=C --auth=trust"

  # Allow local TCP connections (needed by the backend and wait-for-pg.sh)
  echo "host all all 127.0.0.1/32 trust" >> "${PG_DATA}/pg_hba.conf"

  # Start temporarily to provision the database
  su -s /bin/bash postgres -c \
    "/usr/lib/postgresql/16/bin/pg_ctl start -D ${PG_DATA} -w -t 30 -o '-k /tmp'"

  su -s /bin/bash postgres -c "psql -h /tmp -c \"CREATE DATABASE ${DB_NAME};\""
  su -s /bin/bash postgres -c "psql -h /tmp -c \"CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASSWORD}';\""
  su -s /bin/bash postgres -c "psql -h /tmp -c \"GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};\""
  su -s /bin/bash postgres -c "psql -h /tmp -c \"ALTER DATABASE ${DB_NAME} OWNER TO ${DB_USER};\""
  su -s /bin/bash postgres -c "psql -h /tmp -d ${DB_NAME} -c \"GRANT ALL ON SCHEMA public TO ${DB_USER};\""

  su -s /bin/bash postgres -c \
    "/usr/lib/postgresql/16/bin/pg_ctl stop -D ${PG_DATA} -w"

  echo "[qa] PostgreSQL initialised."
fi

# ── 7. Generate supervisord.conf and start all services ───────────────────────
echo "[qa] Generating supervisord config..."

SUPERVISORD_CONF="/etc/supervisor/conf.d/qa.conf"

cat > "${SUPERVISORD_CONF}" <<SUPEREOF
[supervisord]
nodaemon=true
logfile=/var/log/supervisor/supervisord.log
logfile_maxbytes=10MB
loglevel=info
SUPEREOF

# PostgreSQL — only when a database is configured
if [ -n "${DB_NAME}" ]; then
  cat >> "${SUPERVISORD_CONF}" <<SUPEREOF

[program:postgresql]
command=/usr/lib/postgresql/16/bin/postgres -D /var/lib/postgresql/16/main
user=postgres
autostart=true
autorestart=true
priority=10
stdout_logfile=/var/log/supervisor/postgresql.log
stderr_logfile=/var/log/supervisor/postgresql.log
SUPEREOF
fi

# Backend — only when BACKEND_DIR is configured
if [ -n "${BACKEND_DIR}" ]; then
  # Generate a small wrapper so we avoid quoting issues in supervisord command=
  BACKEND_WRAPPER="/usr/local/bin/start-backend.sh"
  {
    echo "#!/bin/bash"
    echo "set -e"
    [ -n "${DB_NAME}" ] && echo "/usr/local/bin/wait-for-pg.sh"
    echo "exec ${BACKEND_RUN_CMD}"
  } > "${BACKEND_WRAPPER}"
  chmod +x "${BACKEND_WRAPPER}"

  # Build the environment string for supervisord
  # Values with spaces or special chars should be quoted inside the env string
  {
    printf '[program:backend]\n'
    printf 'command=%s\n' "${BACKEND_WRAPPER}"
    printf 'environment='
    printf 'DB_HOST="127.0.0.1",'
    printf 'DB_PORT="%s",' "${DB_PORT}"
    printf 'DB_NAME="%s",'   "${DB_NAME}"
    printf 'DB_USER="%s",'   "${DB_USER}"
    printf 'DB_PASSWORD="%s",' "${DB_PASSWORD}"
    printf 'SERVER_PORT="%s"'  "${BACKEND_PORT}"
    [ -n "${JWT_SECRET}" ] && printf ',JWT_SECRET="%s"'  "${JWT_SECRET}"
    [ -n "${JWT_ISSUER}" ] && printf ',JWT_ISSUER="%s"'  "${JWT_ISSUER}"
    printf '\n'
    printf 'autostart=true\n'
    printf 'autorestart=true\n'
    printf 'priority=20\n'
    printf 'startsecs=5\n'
    printf 'stdout_logfile=/var/log/supervisor/backend.log\n'
    printf 'stderr_logfile=/var/log/supervisor/backend.log\n'
  } >> "${SUPERVISORD_CONF}"
fi

# nginx — always present (serves the static frontend)
cat >> "${SUPERVISORD_CONF}" <<SUPEREOF

[program:nginx]
command=/usr/sbin/nginx -g "daemon off;"
autostart=true
autorestart=true
priority=30
stdout_logfile=/var/log/supervisor/nginx.log
stderr_logfile=/var/log/supervisor/nginx.log
SUPEREOF

echo "[qa] Starting supervisord (services: postgresql=${DB_NAME:-off}, backend=${BACKEND_DIR:-off}, nginx=on)..."
exec /usr/bin/supervisord -n -c "${SUPERVISORD_CONF}"
