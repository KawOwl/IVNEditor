# syntax=docker/dockerfile:1.7
#
# IVN 引擎镜像 —— 前端 build + 后端一起打包
#
# 分层策略（从下到上，变动从少到多）：
#   Layer 1: 基础镜像（几乎不变）
#   Layer 2: 前端依赖（package.json + pnpm-lock.yaml 变才重装）
#   Layer 3: 后端依赖（server/package.json 变才重装）
#   Layer 4: 前端源码 + build（改前端代码才重构建）
#   Layer 5: 后端源码（改后端代码才重拷贝）
#
# 效果：只改 server/src/ 下代码 → 只 rebuild Layer 5 + 最终组装
#       镜像增量推送只有几 MB（后端 TS 源码）
#
# 用法：
#   docker build -t registry-vpc.cn-shenzhen.aliyuncs.com/你的 ns/ivn-engine:v1 .
#   docker push registry-vpc.cn-shenzhen.aliyuncs.com/你的 ns/ivn-engine:v1

# ============================================================
# Stage 1: 前端 builder —— 用 Node + pnpm 做 vite build
# ============================================================
# Node 24（当前 Current，2026-10 转 Active LTS）。Vite 8 要 ≥ 20.19 或 22.12+，24 满足。
# Node 22 也行（Active LTS 到 2027-04），build stage 是丢弃层，选新的。
FROM node:24-alpine AS frontend-builder
WORKDIR /build

# pnpm 通过 corepack 激活。packageManager 字段锁在 package.json，corepack 用那个版本
RUN corepack enable && corepack prepare pnpm@10.12.4 --activate

# --- Layer 2a: 前端依赖（只在 package.json / lock 变化时重跑）---
# 单独 COPY 这两个文件，利用 Docker layer cache
COPY package.json pnpm-lock.yaml ./
# --mount=type=cache 让 pnpm store 跨 build 复用，二次构建秒级
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prefer-offline

# --- Layer 4a: 前端源码 + build ---
# 只 copy vite build 需要的源码（避免 server/ 变动触发前端 rebuild）
COPY index.html ./
COPY tsconfig.json ./
COPY tsconfig.tsbuildinfo* ./
COPY components.json ./
COPY vite.config.ts ./
COPY src/ ./src/
# 如果有 public/ 或其他 vite 需要的目录，在这里补
# COPY public/ ./public/

RUN pnpm build
# 产物在 /build/dist/

# ============================================================
# Stage 2: 后端依赖 —— 用 Bun 解 server 依赖
# ============================================================
FROM oven/bun:1.3-alpine AS backend-deps
WORKDIR /app/server

# --- Layer 3: 后端依赖（只在 server/package.json 变化时重跑）---
COPY server/package.json server/bun.lock* ./
RUN --mount=type=cache,id=bun-cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# ============================================================
# Stage 3: 运行镜像 —— 组装最终镜像
# ============================================================
FROM oven/bun:1.3-alpine AS runtime
WORKDIR /app

# 运行时依赖：curl 用于 healthcheck、tini 当 PID 1（优雅退出）
RUN apk add --no-cache curl tini

# --- Layer 3 继续：把 node_modules 从 deps stage 拷过来 ---
# 这是"大"但"稳定"的层——只在 server/package.json 变化时失效
COPY --from=backend-deps /app/server/node_modules ./server/node_modules

# --- Layer 5: 后端源码（改代码最常重跑的层，体积小）---
# 关键：源码放在依赖之后，这样改 src 不会触发重装依赖
COPY server/src/ ./server/src/
COPY server/drizzle/ ./server/drizzle/
COPY server/drizzle.config.ts ./server/
COPY server/scripts/ ./server/scripts/
COPY server/tsconfig.json ./server/
COPY server/package.json ./server/
# 运行时也要 bun.lock：`bun run` 启动时若没 lock，会按 package.json 的 `^x` 重新
# resolve 最新版本，绕过 `bun install --frozen-lockfile` 在 backend-deps 阶段装进
# node_modules 的确定版本。曾因此踩过 `ai@6.0.168` 里的 `zod/v4` peer dep
# 不兼容问题，根因就是 runtime 缺 lock → 重 resolve → 拿到非 lockfile 指定版本。
COPY server/bun.lock* ./server/

# --- 前端 dist 需要在项目根（server 代码里 DIST_DIR = ../../dist）---
COPY --from=frontend-builder /build/dist ./dist

# 共享 core 源码（server 的 TS 代码会 import ../../src/core/*）
COPY src/core/ ./src/core/
COPY tsconfig.json ./

# ============================================================
# 运行时配置
# ============================================================
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# 非 root 用户跑（oven/bun 镜像自带 bun 用户）
USER bun

# tini 保证 Bun 收到 SIGTERM 时正常清理（K8s rollout 依赖）
ENTRYPOINT ["/sbin/tini", "--"]

WORKDIR /app/server
CMD ["bun", "run", "src/index.ts"]
