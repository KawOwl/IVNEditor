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
# WORKDIR /app：node_modules 装到 /app/node_modules，这样 server/src/* 和
# src/core/*（二者都被 server 运行时加载）向上找 node_modules 都能命中。
# 如果装在 /app/server/node_modules 下，src/core/ 里的代码（如
# `import 'zod/v4'` in tool-executor.ts）因为 node resolution 从
# /app/src/core/ 向上不经过 server/，会 ENOENT。
FROM oven/bun:1.3-alpine AS backend-deps
WORKDIR /app

# --- Layer 3: 后端依赖（只在 server/package.json 变化时重跑）---
# 把 server/package.json 作为 /app/package.json —— 逻辑上 server 还是独立
# 子项目（本地源码仍在 server/package.json），只是 runtime 把它提到根
# 位置让 node_modules 对整个 /app tree 可见。
COPY server/package.json ./package.json
COPY server/bun.lock* ./
# --linker=hoisted：走 npm 式扁平 node_modules，不用 bun 1.3 默认的 isolated
# cache 结构。默认 isolated 模式下 bun 运行时会从 ~/.bun/install/cache/pkg@@@N
# 里加载模块，peer dep 和 variant 解析会挑出和 lockfile 不一致的版本（踩过
# ai@6.0.168 拿到而不是 lockfile pin 的 6.0.143 → zod/v4 import 解析挂）。
# hoisted 保证 node_modules/pkg 就是 bun 实际读的那份。
RUN --mount=type=cache,id=bun-cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --linker=hoisted

# ============================================================
# Stage 3: 运行镜像 —— 组装最终镜像
# ============================================================
FROM oven/bun:1.3-alpine AS runtime
WORKDIR /app

# 运行时依赖：curl 用于 healthcheck、tini 当 PID 1（优雅退出）
RUN apk add --no-cache curl tini

# --- Layer 3 继续：把 node_modules + package.json + lockfile 从 deps stage 拷到 /app 根 ---
# node_modules 在 /app/node_modules，server/src/* 和 src/core/* 两路都能
# 向上解析到这份依赖。这是"大"但"稳定"的层——只在 server/package.json 变化时失效。
COPY --from=backend-deps /app/node_modules ./node_modules
COPY --from=backend-deps /app/package.json ./package.json
# 运行时也要 bun.lock：`bun run` 启动时若没 lock，会按 package.json 的 `^x`
# 重新 resolve 最新版本，绕过 backend-deps 里装的确定版本。踩过 ai@6.0.168
# 里的 zod/v4 peer dep 不兼容问题。
COPY --from=backend-deps /app/bun.lock* ./

# --- Layer 5: 后端源码（改代码最常重跑的层，体积小）---
# 关键：源码放在依赖之后，这样改 src 不会触发重装依赖
COPY server/src/ ./server/src/
COPY server/drizzle/ ./server/drizzle/
COPY server/drizzle.config.ts ./server/
COPY server/scripts/ ./server/scripts/
COPY server/tsconfig.json ./server/

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
