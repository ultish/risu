# Long-term runnable image: pinned Node, lockfile install, SQLite volume.
# One container: API + built web static (SERVE_WEB=1).
FROM node:22-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@9.5.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile || pnpm install

FROM deps AS build
COPY . .
RUN pnpm --filter @yields/core build \
 && pnpm --filter @yields/api build \
 && pnpm --filter @yields/web build

FROM base AS runtime
ENV NODE_ENV=production
ENV YIELDS_DB_PATH=/data/risu.db
ENV PORT=8787
# API serves apps/web/dist when present (see apps/api/src/index.ts)
ENV SERVE_WEB=1
COPY --from=build /app /app
RUN mkdir -p /data \
 && test -f /app/apps/web/dist/index.html
VOLUME ["/data"]
EXPOSE 8787
WORKDIR /app/apps/api
# Relative web dist from WORKDIR: ../web/dist
CMD ["node", "--import", "tsx", "src/index.ts"]
