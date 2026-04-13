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
RUN npm install --omit=dev
COPY gateway/ ./

# Copy compiled dashboard into gateway's public folder
# vite.config.js outDir is '../gateway/public', so the build lands at /app/gateway/public
COPY --from=builder /app/gateway/public ./public

EXPOSE 3000
EXPOSE 4000
CMD ["node", "src/index.js"]
