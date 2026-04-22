# ── Temurin 21 JDK ────────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        temurin-21-jdk \
 && rm -rf /var/lib/apt/lists/*
