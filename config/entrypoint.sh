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

# ─── Determine if postgres is required ───────────────────────────────────────
NEEDS_DB=$("${PYBIN}" -c "
import sys, json
svcs = json.loads(sys.argv[1])
needs = any(s.get('stack','') in ('spring','gradle') for s in svcs)
print('true' if needs else 'false')
" "${FLEET_SERVICES_JSON}")

PG_DATA="/var/lib/postgresql/16/main"

# ─── 1. Initialise PostgreSQL cluster (first boot only) ──────────────────────
if [ "${NEEDS_DB}" = "true" ] && [ ! -f "${PG_DATA}/PG_VERSION" ]; then
  echo "[fleet] First start — initialising PostgreSQL cluster..."

  su -s /bin/bash postgres -c \
    "/usr/lib/postgresql/16/bin/initdb -D ${PG_DATA} -E UTF8 --locale=C --auth=trust"

  # Allow local TCP connections
  echo "host all all 127.0.0.1/32 trust" >> "${PG_DATA}/pg_hba.conf"

  # Start temporarily to provision the database
  su -s /bin/bash postgres -c \
    "/usr/lib/postgresql/16/bin/pg_ctl start -D ${PG_DATA} -w -t 30 -o '-k /tmp'"

  su -s /bin/bash postgres -c "psql -h /tmp -c \"CREATE DATABASE ${DB_NAME};\""
  su -s /bin/bash postgres -c "psql -h /tmp -c \"CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASSWORD}';\""
  su -s /bin/bash postgres -c "psql -h /tmp -c \"GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};\""
  su -s /bin/bash postgres -c "psql -h /tmp -c \"ALTER DATABASE ${DB_NAME} OWNER TO ${DB_USER};\""
  su -s /bin/bash postgres -c \
    "psql -h /tmp -d ${DB_NAME} -c \"GRANT ALL ON SCHEMA public TO ${DB_USER};\""

  su -s /bin/bash postgres -c \
    "/usr/lib/postgresql/16/bin/pg_ctl stop -D ${PG_DATA} -w"

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
SUPEREOF

# PostgreSQL program block
if [ "${NEEDS_DB}" = "true" ]; then
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
    wrapper = '/usr/local/bin/start-' + name + '.sh'
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
import sys, json

svcs = json.loads(sys.argv[1])

# Pick a default service for catch-all 'location /'.
# Prefer one named 'frontend', else the first service with a frontend-ish stack.
FRONTEND_STACKS = {'vite', 'next', 'webpack', 'react', 'vue'}
default_svc = next((s for s in svcs if s.get('name') == 'frontend' and s.get('port')), None) \
    or next((s for s in svcs if s.get('stack') in FRONTEND_STACKS and s.get('port')), None)

lines = ['server {']
lines.append('    listen 80;')
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
