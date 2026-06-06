# Stage 1 — build the dashboard
FROM node:20-alpine AS builder
WORKDIR /app/dashboard
COPY dashboard/package*.json ./
RUN npm install
COPY dashboard/ ./
RUN npm run build

# Stage 2 — gateway runtime
FROM node:20-alpine
WORKDIR /app/gateway
COPY gateway/package*.json ./
# better-sqlite3 has no prebuilt musl/arm64 binary; node-gyp compile needs toolchain
RUN apk add --no-cache python3 make g++
RUN npm install --omit=dev
COPY gateway/ ./

# Copy compiled dashboard into gateway's public folder
# vite.config.js outDir is '../gateway/public', so the build lands at /app/gateway/public
COPY --from=builder /app/gateway/public ./public

EXPOSE 3000
EXPOSE 4000
EXPOSE 8080
CMD ["node", "src/index.js"]
