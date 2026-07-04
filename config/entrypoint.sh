#!/bin/bash
# config/entrypoint.sh
# Unified fleet feature-container entrypoint.
#
# Reads FLEET_SERVICES_JSON and FLEET_PEERS_JSON (set by docker-compose) and:
#   1. Optionally initialises an embedded PostgreSQL cluster (if any service is
#      stack=spring or stack=gradle).
#   2. Generates /etc/supervisor/conf.d/fleet.conf with one [program:] block
#      per [[services]] entry and one per [[peers]] entry.
#   3. Generates /etc/nginx/conf.d/feature.conf with a location block for
#      each service (peers are internal-only — not routed through nginx).
#   4. Execs supervisord as PID 1 via tini.
set -e

# ─── Required env ────────────────────────────────────────────────────────────
APP_NAME="${APP_NAME:-fleet-feature}"
BRANCH="${BRANCH:-unknown}"
PROJECT_NAME="${PROJECT_NAME:-}"

# JSON arrays injected by docker-compose
FLEET_SERVICES_JSON="${FLEET_SERVICES_JSON:-[]}"
FLEET_PEERS_JSON="${FLEET_PEERS_JSON:-[]}"

# Source shared env files early so DB_USER/DB_NAME/DB_PASSWORD from .env
# override the defaults below before PostgreSQL cluster initialisation.
if [ -n "${FLEET_SHARED_ENV_FILES:-}" ]; then
  IFS=':' read -ra _early_files <<< "${FLEET_SHARED_ENV_FILES}"
  for _f in "${_early_files[@]}"; do
    [ -r "$_f" ] && set -a && . "$_f" && set +a
  done
fi

# DB credentials (used only when a spring/gradle service is present)
DB_NAME="${DB_NAME:-${PROJECT_NAME:-fleet}}"
DB_USER="${DB_USER:-${PROJECT_NAME:-fleet}}"
DB_PASSWORD="${DB_PASSWORD:-fleet}"

# ─── Python helper ────────────────────────────────────────────────────────────
PYBIN=python3

echo "[fleet] ================================================================"
echo "[fleet] Feature:  ${APP_NAME}  |  Branch: ${BRANCH}"
echo "[fleet] ================================================================"

# ─── OpenShift restricted-SCC: synthesize a passwd entry via nss_wrapper ──────
# PostgreSQL's getpwuid() aborts when the running UID has no /etc/passwd entry.
# /etc/passwd is root-owned and not writable here, so use libnss_wrapper to
# inject a fake entry for the current UID at runtime.  Export the vars before
# any PG binary call so the supervisord-launched postgres daemon inherits them.
#
# PG_RUNTIME_USER names the PostgreSQL superuser that initdb will create.  Root
# uses the system `postgres` account; non-root (nss_wrapper) synthesizes a user
# named `fleetpg`.  The variable is the single source of truth — the passwd
# entry and the PGUSER export both derive from it so they can never drift.
PG_RUNTIME_USER=postgres
if ! id -un >/dev/null 2>&1; then
  _nss_lib="$(find /usr/lib -name libnss_wrapper.so 2>/dev/null | head -1)"
  if [ -n "${_nss_lib}" ]; then
    PG_RUNTIME_USER=fleetpg
    export NSS_WRAPPER_PASSWD=/tmp/fleet-passwd
    export NSS_WRAPPER_GROUP=/tmp/fleet-group
    cp /etc/passwd "${NSS_WRAPPER_PASSWD}"
    cp /etc/group  "${NSS_WRAPPER_GROUP}"
    printf '%s:x:%s:0:fleet pg:/tmp:/bin/bash\n' "${PG_RUNTIME_USER}" "$(id -u)" >> "${NSS_WRAPPER_PASSWD}"
    export LD_PRELOAD="${_nss_lib}"
  else
    echo "[fleet] WARN: UID $(id -u) not in /etc/passwd and libnss_wrapper.so absent — PostgreSQL init will fail" >&2
  fi
fi

# ─── Determine if postgres is required ───────────────────────────────────────
NEEDS_DB=$("${PYBIN}" -c "
import sys, json
svcs = json.loads(sys.argv[1])
needs = any(s.get('stack','') in ('spring','gradle') for s in svcs)
print('true' if needs else 'false')
" "${FLEET_SERVICES_JSON}")

# pgdata/ is a subdirectory created at runtime so the running UID owns it and
# initdb's internal chmod 0700 succeeds (only owner may chmod).
PG_DATA="/var/lib/postgresql/16/main/pgdata"

# ─── 1. Initialise PostgreSQL cluster (first boot only) ──────────────────────
if [ "${NEEDS_DB}" = "true" ] && [ ! -f "${PG_DATA}/PG_VERSION" ]; then
  echo "[fleet] First start — initialising PostgreSQL cluster..."
  # Create the data dir as the running UID so initdb's chmod 0700 succeeds.
  mkdir -p "${PG_DATA}"

  # PostgreSQL binaries (initdb, pg_ctl, postgres) refuse to run as UID 0.
  # When the container is root (the default — no USER directive in the
  # generated Dockerfile.feature-base), chown the data dir and drop to the
  # system 'postgres' account via runuser for each PG binary invocation.
  # In OpenShift restricted-SCC environments the container already runs as a
  # non-root UID (CAP_SETUID is absent, so runuser would fail there); we fall
  # through to direct exec — PG binaries accept any non-zero UID (nss_wrapper
  # synthesizes a passwd entry above so getpwuid() succeeds).
  if [ "$(id -u)" = "0" ]; then
    chown -R postgres:postgres "${PG_DATA}"
    _pgbin() { runuser -u postgres -- "$@"; }
    # psql defaults to the OS username as the PG role; override so the
    # provisioning queries below run as the postgres superuser.
    export PGUSER="${PG_RUNTIME_USER}"
  else
    _pgbin() { "$@"; }
    # nss_wrapper synthesized the superuser as `fleetpg` (PG_RUNTIME_USER);
    # initdb names the superuser after the OS user, but the default *database*
    # is still `postgres`.  Point libpq at both so the provisioning psql calls
    # below do not default role+dbname to `fleetpg` (role exists, db does not).
    export PGUSER="${PG_RUNTIME_USER}"
    export PGDATABASE=postgres
  fi

  _pgbin /usr/lib/postgresql/16/bin/initdb -D "${PG_DATA}" -E UTF8 --locale=C --auth=trust

  # Allow local TCP connections
  echo "host all all 127.0.0.1/32 trust" >> "${PG_DATA}/pg_hba.conf"

  # Start temporarily to provision the database
  _pgbin /usr/lib/postgresql/16/bin/pg_ctl start -D "${PG_DATA}" -w -t 30 -o '-k /tmp'

  # Idempotent: DB_NAME/DB_USER may already exist (e.g. the built-in `postgres`
  # superuser when DB_USER=postgres, or a re-provision). Guard so `set -e` does
  # not abort the whole entrypoint on a benign "already exists".
  psql -h /tmp -tc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}';" | grep -q 1 || psql -h /tmp -c "CREATE DATABASE ${DB_NAME};"
  psql -h /tmp -c "DO \$\$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}') THEN ALTER ROLE ${DB_USER} WITH PASSWORD '${DB_PASSWORD}'; ELSE CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASSWORD}'; END IF; END \$\$;"
  # CREATEDB so build-time tooling (e.g. jOOQ codegen with -PjooqUseLocalDb) can
  # create/drop its own throwaway databases without needing the postgres superuser.
  psql -h /tmp -c "ALTER ROLE ${DB_USER} CREATEDB;"
  psql -h /tmp -c "GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};"
  psql -h /tmp -c "ALTER DATABASE ${DB_NAME} OWNER TO ${DB_USER};"
  psql -h /tmp -d "${DB_NAME}" -c "GRANT ALL ON SCHEMA public TO ${DB_USER};"

  _pgbin /usr/lib/postgresql/16/bin/pg_ctl stop -D "${PG_DATA}" -w

  echo "[fleet] PostgreSQL initialised (db=${DB_NAME}, user=${DB_USER})."
elif [ "${NEEDS_DB}" = "true" ]; then
  echo "[fleet] PostgreSQL cluster already initialised — skipping initdb."
fi

# ─── 2. Generate supervisord config ──────────────────────────────────────────
echo "[fleet] Generating supervisord config..."
SUPERVISORD_CONF="/etc/supervisor/conf.d/fleet.conf"

cat > "${SUPERVISORD_CONF}" <<SUPEREOF
[supervisord]
nodaemon=true
logfile=/var/log/supervisor/supervisord.log
logfile_maxbytes=10MB
loglevel=info
pidfile=/tmp/supervisord.pid

[unix_http_server]
file=/tmp/supervisor.sock
chmod=0700

[rpcinterface:supervisor]
supervisor.rpcinterface_factory = supervisor.rpcinterface:make_main_rpcinterface

[supervisorctl]
serverurl=unix:///tmp/supervisor.sock
SUPEREOF

# PostgreSQL program block
if [ "${NEEDS_DB}" = "true" ]; then
  # Write the program block piece-by-piece so the user= directive is only
  # emitted when running as root (supervisord requires root to switch users;
  # under OpenShift's restricted SCC the daemon runs as an arbitrary non-root
  # UID and must not carry a user= line).
  {
    printf '\n[program:postgresql]\n'
    # -k /tmp: unix socket in /tmp so any non-root UID (e.g. OpenShift's 9876:0)
    # can create it.  /var/run/postgresql is postgres:postgres owned and not
    # group-0 writable, so it is off-limits for arbitrary non-root UIDs.
    # This is consistent with the provisioning pg_ctl start above (also -k /tmp).
    printf 'command=/usr/lib/postgresql/16/bin/postgres -D %s -k /tmp\n' "${PG_DATA}"
    [ "$(id -u)" = "0" ] && printf 'user=postgres\n'
    printf 'autostart=true\nautorestart=true\npriority=10\n'
    printf 'stdout_logfile=/var/log/supervisor/postgresql.log\n'
    printf 'stderr_logfile=/var/log/supervisor/postgresql.log\n'
  } >> "${SUPERVISORD_CONF}"
fi

# Service program blocks — one per [[services]] entry
"${PYBIN}" -c "
import sys, json, os

svcs = json.loads(sys.argv[1])
needs_db = sys.argv[2] == 'true'

for svc in svcs:
    name    = svc.get('name','')
    run_cmd = svc.get('run','')
    port    = svc.get('port','')
    stack   = svc.get('stack','')
    build   = svc.get('build','')
    svc_dir = '/app/' + name

    # Emit a build+run wrapper so we avoid quoting hell in supervisord command=
    # Use /tmp so the file is writable by any non-root UID (OpenShift SCC).
    wrapper = '/tmp/start-' + name + '.sh'
    with open(wrapper, 'w') as f:
        f.write('#!/bin/bash\nset -e\n')
        f.write('cd ' + svc_dir + '\n')

        if stack in ('spring', 'gradle'):
            # Restore gradlew execute bit (lost across macOS→Linux bind mounts)
            f.write('[ -f ./gradlew ] && chmod +x ./gradlew\n')
            if build:
                f.write('echo \"[fleet] Building ' + name + '...\"\n')
                f.write(build + '\n')
                # Copy main jar to stable path
                f.write('''
# Locate main jar and copy to stable path
find_jar() { local d=\"\$1\"; [ -d \"\$d\" ] || return 1; find \"\$d\" -maxdepth 1 -type f -name \"*.jar\" \\! -name \"*-plain.jar\" \\! -name \"*-sources.jar\" \\! -name \"*-javadoc.jar\" 2>/dev/null | head -n 1; }
JAR=\"\"
for _d in build/libs target; do JAR=\$(find_jar \"\$_d\" || true); [ -n \"\$JAR\" ] && break; done
if [ -n \"\$JAR\" ]; then cp \"\$JAR\" /home/developer/''' + name + '''.jar; fi
''')
            if needs_db:
                f.write('/usr/local/bin/wait-for-pg.sh\n')
            if port:
                f.write('export SERVER_PORT=' + str(port) + '\n')

        # Node/Vite services: reconcile node_modules against package.json on every
        # start. Fast on a warm named volume; installs arch-correct native deps
        # the first time (or after package-lock changes).
        if stack in ('vite', 'next', 'webpack') or (stack == '' and os.path.isfile(svc_dir + '/package.json')):
            f.write('if [ -f package.json ]; then\n')
            f.write('  echo \"[fleet] Reconciling ' + name + ' node_modules (arch=$(uname -m))...\"\n')
            f.write('  npm install --no-audit --no-fund --loglevel=error\n')
            f.write('fi\n')

        if run_cmd:
            f.write('exec ' + run_cmd + '\n')
        else:
            f.write('echo \"[fleet] No run command for ' + name + '\" && sleep infinity\n')

    os.chmod(wrapper, 0o755)

    env_parts = []
    if stack in ('spring', 'gradle'):
        env_parts += [
            'DB_HOST=\"127.0.0.1\"',
            'DB_PORT=\"5432\"',
            'DB_NAME=\"' + os.environ.get('DB_NAME','') + '\"',
            'DB_USER=\"' + os.environ.get('DB_USER','') + '\"',
            'DB_PASSWORD=\"' + os.environ.get('DB_PASSWORD','') + '\"',
        ]
        if port:
            env_parts.append('SERVER_PORT=\"' + str(port) + '\"')
        jwt_secret = os.environ.get('JWT_SECRET','')
        jwt_issuer = os.environ.get('JWT_ISSUER','')
        if jwt_secret:
            env_parts.append('JWT_SECRET=\"' + jwt_secret + '\"')
        if jwt_issuer:
            env_parts.append('JWT_ISSUER=\"' + jwt_issuer + '\"')
    env_line = 'environment=' + ','.join(env_parts) if env_parts else ''

    block = '\n[program:' + name + ']\n'
    block += 'command=' + wrapper + '\n'
    block += 'directory=' + svc_dir + '\n'
    if env_line:
        block += env_line + '\n'
    block += 'autostart=true\nautorestart=true\n'
    block += 'priority=20\n'
    block += 'startsecs=5\n'
    block += 'stdout_logfile=/var/log/supervisor/' + name + '.log\n'
    block += 'stderr_logfile=/var/log/supervisor/' + name + '.log\n'

    with open('/etc/supervisor/conf.d/fleet.conf', 'a') as f:
        f.write(block)

print('[fleet] Wrote ' + str(len(svcs)) + ' service program(s) to supervisord config.')
" "${FLEET_SERVICES_JSON}" "${NEEDS_DB}"

# Peer program blocks — one per [[peers]] entry
"${PYBIN}" -c "
import sys, json

peers = json.loads(sys.argv[1])

for peer in peers:
    name      = peer.get('name','')
    ptype     = peer.get('type','')
    port      = str(peer.get('port','8080'))
    peer_cmd  = peer.get('cmd','')
    peer_dir  = '/app/' + name

    if ptype == 'wiremock':
        cmd = 'java -jar /opt/wiremock/wiremock.jar --root-dir ' + peer_dir + ' --port ' + port + ' --disable-banner'
    elif ptype == 'static-http':
        cmd = 'python3 -m http.server --directory ' + peer_dir + ' ' + port
    elif ptype == 'shell':
        cmd = peer_cmd if peer_cmd else 'echo \"[fleet] peer ' + name + ' has no cmd\" && sleep infinity'
    else:
        # Whitelist enforced by load_fleet_toml; this is a safety fallback
        cmd = 'echo \"[fleet] unknown peer type ' + ptype + '\" && sleep infinity'

    block = '\n[program:' + name + ']\n'
    block += 'command=' + cmd + '\n'
    block += 'directory=' + peer_dir + '\n'
    block += 'autostart=true\nautorestart=true\n'
    block += 'priority=15\n'
    block += 'stdout_logfile=/var/log/supervisor/' + name + '.log\n'
    block += 'stderr_logfile=/var/log/supervisor/' + name + '.log\n'

    with open('/etc/supervisor/conf.d/fleet.conf', 'a') as f:
        f.write(block)

print('[fleet] Wrote ' + str(len(peers)) + ' peer program(s) to supervisord config.')
" "${FLEET_PEERS_JSON}"

# nginx program block — always last
cat >> "${SUPERVISORD_CONF}" <<SUPEREOF

[program:nginx]
command=/usr/sbin/nginx -g "daemon off;"
autostart=true
autorestart=true
priority=30
stdout_logfile=/var/log/supervisor/nginx.log
stderr_logfile=/var/log/supervisor/nginx.log
SUPEREOF

# ─── 3. Generate nginx feature.conf ──────────────────────────────────────────
echo "[fleet] Generating nginx config..."
NGINX_CONF="/etc/nginx/conf.d/feature.conf"

"${PYBIN}" -c "
import sys, json, os

svcs = json.loads(sys.argv[1])

# Pick a default service for catch-all 'location /'.
# Prefer one named 'frontend', else the first service with a frontend-ish stack.
FRONTEND_STACKS = {'vite', 'next', 'webpack', 'react', 'vue'}
default_svc = next((s for s in svcs if s.get('name') == 'frontend' and s.get('port')), None) \
    or next((s for s in svcs if s.get('stack') in FRONTEND_STACKS and s.get('port')), None)

nginx_port = os.environ.get('NGINX_PORT', '8080')
lines = ['server {']
lines.append('    listen ' + nginx_port + ';')
lines.append('    access_log /dev/stdout;')
lines.append('    error_log /dev/stderr warn;')
lines.append('')

for svc in svcs:
    name = svc.get('name','')
    port = str(svc.get('port',''))
    if not name or not port:
        continue
    lines.append('    # ' + name)
    lines.append('    location /' + name + '/ {')
    lines.append('        proxy_pass http://127.0.0.1:' + port + '/;')
    lines.append('        proxy_http_version 1.1;')
    lines.append('        proxy_set_header Upgrade \$http_upgrade;')
    lines.append('        proxy_set_header Connection \"upgrade\";')
    lines.append('        proxy_set_header Host \$host;')
    lines.append('        proxy_set_header X-Real-IP \$remote_addr;')
    lines.append('        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;')
    lines.append('        proxy_read_timeout 120s;')
    lines.append('        proxy_connect_timeout 10s;')
    lines.append('    }')
    lines.append('')

# Catch-all: unmatched paths (including /) go to the default frontend service.
# Vite and SPAs emit absolute asset paths (/@vite/client, /favicon.svg) that
# otherwise fall through to nginx's default Debian welcome page.
if default_svc:
    port = str(default_svc['port'])
    lines.append('    # default: ' + default_svc['name'] + ' (catch-all for SPA assets)')
    lines.append('    location / {')
    lines.append('        proxy_pass http://127.0.0.1:' + port + ';')
    lines.append('        proxy_http_version 1.1;')
    lines.append('        proxy_set_header Upgrade \$http_upgrade;')
    lines.append('        proxy_set_header Connection \"upgrade\";')
    lines.append('        proxy_set_header Host \$host;')
    lines.append('        proxy_set_header X-Real-IP \$remote_addr;')
    lines.append('        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;')
    lines.append('        proxy_read_timeout 120s;')
    lines.append('        proxy_connect_timeout 10s;')
    lines.append('    }')
    lines.append('')

lines.append('}')
print('\n'.join(lines))
" "${FLEET_SERVICES_JSON}" > "${NGINX_CONF}"

# Remove the legacy qa template symlink (nginx would fail with two server blocks
# on port 80). The feature.conf from conf.d is sufficient.
rm -f /etc/nginx/sites-enabled/qa 2>/dev/null || true

# ─── 4. Source shared env files ──────────────────────────────────────────────
if [ -n "${FLEET_SHARED_ENV_FILES:-}" ]; then
  IFS=':' read -ra _files <<< "${FLEET_SHARED_ENV_FILES}"
  for f in "${_files[@]}"; do
    [ -r "$f" ] && set -a && . "$f" && set +a
  done
fi

echo "[fleet] Starting supervisord..."
exec /usr/bin/supervisord -n -c "${SUPERVISORD_CONF}"
