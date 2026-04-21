# Monolith image: Vite SPA in /app/public + API (Playwright). Apex can point at this service only.
# Build from repo root: docker build -t cloneai .
# Render: dockerfilePath ./Dockerfile, dockerContext .

FROM node:20-bookworm-slim AS frontend-builder
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN cd frontend && npm ci
COPY frontend ./frontend
# Must match the browser-visible API origin (same host when apex → this service).
ARG VITE_API_ORIGIN=https://siteclonerpro.com
ARG VITE_PUBLIC_APP_ORIGIN=https://siteclonerpro.com
ENV VITE_API_URL=$VITE_API_ORIGIN
ENV VITE_PUBLIC_APP_URL=$VITE_PUBLIC_APP_ORIGIN
# Render passes service env vars as Docker build args (same key names).
# Set CLONEAI_INGRESS_KEY on the service once; the SPA gets it as VITE_CLONEAI_KEY at build time.
# Override with VITE_CLONEAI_KEY if you need a different build-time value (rare).
ARG CLONEAI_INGRESS_KEY=
ARG VITE_CLONEAI_KEY=
RUN export VITE_CLONEAI_KEY="${VITE_CLONEAI_KEY:-$CLONEAI_INGRESS_KEY}" && \
    cd frontend && npm run build

FROM mcr.microsoft.com/playwright:v1.58.2-noble
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
COPY backend/scripts/postinstall-embed-spa.mjs ./scripts/postinstall-embed-spa.mjs
RUN npm ci --omit=dev
COPY backend ./
COPY --from=frontend-builder /build/frontend/dist ./public
ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
