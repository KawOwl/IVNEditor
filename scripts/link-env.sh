#!/usr/bin/env bash
#
# link-env.sh —— 把集中存放的 env 文件软链到当前 worktree 的 apps/server/。
#
# 设计目的：
#   每个新 worktree（含 git worktree / fresh checkout）开工前需要 .env / .env.test。
#   用户把真实文件放在 ~/.config/ivn-editor/ (或 $XDG_CONFIG_HOME/ivn-editor/)，
#   这个脚本在当前 git 仓库根下创建 symlink，幂等，可反复跑。
#
# 用法：
#   pnpm setup:env
#   # 或直接：
#   bash scripts/link-env.sh
#
# 行为契约：
#   - 源文件不存在 → skip 并提示（CI / 新机器友好）
#   - 目标已是 symlink → 用 ln -sfn 重指（处理源路径更新）
#   - 目标是真实文件 → 不覆盖，提示用户手动备份再删
#   - 目标不存在 → 创建 symlink

set -euo pipefail

SRC_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/ivn-editor"
ROOT="$(git rev-parse --show-toplevel)"

link_one() {
  local name="$1" dst_rel="$2"
  local src="$SRC_DIR/$name"
  local dst="$ROOT/$dst_rel"

  if [[ ! -f "$src" ]]; then
    echo "skip: $src 不存在（如需启用，把文件放到该路径再重跑）"
    return 0
  fi

  if [[ -L "$dst" ]]; then
    ln -sfn "$src" "$dst"
    echo "relinked: $dst -> $src"
  elif [[ -e "$dst" ]]; then
    echo "warn: $dst 是真实文件，跳过。手动备份并删除后再重跑此脚本。"
    return 0
  else
    mkdir -p "$(dirname "$dst")"
    ln -s "$src" "$dst"
    echo "linked:   $dst -> $src"
  fi
}

echo "source dir: $SRC_DIR"
echo "worktree:   $ROOT"
echo

link_one .env       apps/server/.env
link_one .env.test  apps/server/.env.test

echo
echo "done."
