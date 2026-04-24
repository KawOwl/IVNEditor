# syntax=docker/dockerfile:1.7
#
# IVN 引擎镜像：pnpm workspace 安装依赖 + Vite 构建前端 + Bun 运行后端。
#
# 约定：
#   - pnpm 是唯一 package manager，锁文件只保留 pnpm-lock.yaml
#   - Bun 只作为 server runtime / test runner，不在镜像里执行 bun install

FROM node:24-alpine AS frontend-builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.12.4 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/ui/package.json ./apps/ui/package.json
COPY packages/core/package.json ./packages/core/package.json

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @ivn/ui...

COPY apps/ui ./apps/ui
COPY packages/core ./packages/core

RUN pnpm --filter @ivn/ui build

FROM node:24-alpine AS backend-deps
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.12.4 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json ./apps/server/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/specification/package.json ./packages/specification/package.json

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter @ivn/server...

FROM oven/bun:1.3-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache curl tini

COPY package.json pnpm-workspace.yaml ./
COPY --from=backend-deps /app/node_modules ./node_modules
COPY --from=backend-deps /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=backend-deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=backend-deps /app/packages/specification/node_modules ./packages/specification/node_modules

COPY apps/server/package.json ./apps/server/package.json
COPY apps/server/tsconfig.json ./apps/server/tsconfig.json
COPY apps/server/drizzle.config.ts ./apps/server/drizzle.config.ts
COPY apps/server/drizzle ./apps/server/drizzle
COPY apps/server/scripts ./apps/server/scripts
COPY apps/server/src ./apps/server/src
COPY apps/server/.env.example ./apps/server/.env.example

COPY packages/core/package.json ./packages/core/package.json
COPY packages/core/tsconfig.json ./packages/core/tsconfig.json
COPY packages/core/src ./packages/core/src

COPY packages/specification/package.json ./packages/specification/package.json
COPY packages/specification/tsconfig.json ./packages/specification/tsconfig.json
COPY packages/specification/src ./packages/specification/src

COPY --from=frontend-builder /app/apps/ui/dist ./apps/ui/dist

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

USER bun

ENTRYPOINT ["/sbin/tini", "--"]
WORKDIR /app/apps/server
CMD ["bun", "run", "src/index.ts"]
