# syntax=docker/dockerfile:1
# Kontekst = koren na repoto (gradi i api i web).

FROM node:22-alpine AS web
WORKDIR /src
COPY web/package.json web/package-lock.json web/
RUN cd web && npm ci --no-audit --no-fund
COPY api/src/domain/calc.ts api/src/domain/calc.ts
COPY web web
RUN cd web && npm run build

FROM node:22-alpine AS api
WORKDIR /app
COPY api/package.json api/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY api/tsconfig.json ./
COPY api/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production PORT=8080 MIGRATIONS_DIR=/app/drizzle WEB_DIR=/app/public
WORKDIR /app
COPY --from=api --chown=node:node /app/node_modules ./node_modules
COPY --from=api --chown=node:node /app/dist ./dist
COPY --from=web --chown=node:node /src/web/dist ./public
COPY --chown=node:node api/drizzle ./drizzle
COPY --chown=node:node api/assets ./assets
# скриптите на агентот (пакет за компјутерот на клиентот, docs/15)
COPY --chown=node:node agent ./agent
COPY --chown=node:node api/package.json ./
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/health >/dev/null || exit 1
# --max-old-space-size: serverot ima 1 GB RAM
CMD ["node", "--max-old-space-size=160", "--enable-source-maps", "dist/server.js"]
