#!/bin/bash
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-5432}"
echo "[wait-for-pg] Waiting for PostgreSQL on ${DB_HOST}:${DB_PORT}..."
until pg_isready -h "${DB_HOST}" -p "${DB_PORT}" -q 2>/dev/null; do
  sleep 1
done
echo "[wait-for-pg] PostgreSQL is ready."
