#!/bin/bash
# config/entrypoint-spring.sh
# Per-service entrypoint for `spring` and `gradle` stacks in the fleet
# per-service container model (one container per [[services]] entry).
#
# Responsibilities (lean — no supervisord, nginx, postgres):
#   1. cd to the mounted source tree at /app.
#   2. Run BACKEND_BUILD_CMD (e.g. `./gradlew bootJar -x test -q` or `mvn package`).
#   3. Locate the produced main jar (Gradle: build/libs/; Maven: target/) and copy
#      it to BACKEND_ARTIFACT_PATH (default /home/developer/backend.jar) so the
#      default BACKEND_RUN_CMD resolves.
#   4. exec BACKEND_RUN_CMD with SERVER_PORT exported to BACKEND_PORT.
#
# Required env:  BACKEND_BUILD_CMD
# Optional env:  BACKEND_RUN_CMD, BACKEND_ARTIFACT_PATH, BACKEND_PORT, APP_NAME

set -e

APP_NAME="${APP_NAME:-fleet-spring-service}"
BACKEND_BUILD_CMD="${BACKEND_BUILD_CMD:?BACKEND_BUILD_CMD env var is required}"
BACKEND_ARTIFACT_PATH="${BACKEND_ARTIFACT_PATH:-/home/developer/backend.jar}"
BACKEND_RUN_CMD="${BACKEND_RUN_CMD:-java -jar ${BACKEND_ARTIFACT_PATH}}"
BACKEND_PORT="${BACKEND_PORT:-8081}"

echo "[fleet-spring] ${APP_NAME} starting"
echo "[fleet-spring]   build: ${BACKEND_BUILD_CMD}"
echo "[fleet-spring]   run:   ${BACKEND_RUN_CMD}"
echo "[fleet-spring]   port:  ${BACKEND_PORT}"

cd /app

# The gradlew wrapper loses +x across macOS->Linux bind mounts. Restore it.
[ -f ./gradlew ] && chmod +x ./gradlew

echo "[fleet-spring] Building..."
eval "${BACKEND_BUILD_CMD}"

# Locate the main jar: Gradle (build/libs) first, Maven (target) second.
# Exclude -plain, -sources, -javadoc artifacts.
find_main_jar() {
  local dir="$1"
  [ -d "${dir}" ] || return 1
  find "${dir}" -maxdepth 1 -type f -name '*.jar' \
    \! -name '*-plain.jar' \
    \! -name '*-sources.jar' \
    \! -name '*-javadoc.jar' \
    2>/dev/null | head -n 1
}

JAR=""
for candidate in build/libs target; do
  JAR=$(find_main_jar "${candidate}" || true)
  [ -n "${JAR}" ] && break
done

if [ -n "${JAR}" ]; then
  mkdir -p "$(dirname "${BACKEND_ARTIFACT_PATH}")"
  cp "${JAR}" "${BACKEND_ARTIFACT_PATH}"
  echo "[fleet-spring] Copied ${JAR} -> ${BACKEND_ARTIFACT_PATH}"
else
  echo "[fleet-spring] WARNING: no main jar found in build/libs or target. BACKEND_RUN_CMD may fail."
fi

# Spring Boot reads SERVER_PORT as its bind port. Container-internal only; the
# gateway reaches us over fleet-net using the per-service port from fleet.toml.
export SERVER_PORT="${BACKEND_PORT}"

# Source shared env files
if [ -n "${FLEET_SHARED_ENV_FILES:-}" ]; then
  IFS=':' read -ra _files <<< "${FLEET_SHARED_ENV_FILES}"
  for f in "${_files[@]}"; do
    [ -r "$f" ] && set -a && . "$f" && set +a
  done
fi

echo "[fleet-spring] Exec: ${BACKEND_RUN_CMD}"
exec bash -c "${BACKEND_RUN_CMD}"
