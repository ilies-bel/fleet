#!/bin/bash
echo "[wait-for-pg] Waiting for PostgreSQL on 127.0.0.1:5432..."
until pg_isready -h 127.0.0.1 -p 5432 -q 2>/dev/null; do
  sleep 1
done
echo "[wait-for-pg] PostgreSQL is ready."
