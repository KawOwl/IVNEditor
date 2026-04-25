#!/usr/bin/env bash
#
# redeploy.sh — 本地一条命令把 staging rollout 到当前 commit
#
# 流程：
#   1. 检查 git tree clean
#   2. 计算 tag = {YYYYMMDD-HHMMSS}-{shortSHA}（UTC）
#   3. build-and-push.sh $tag → 镜像进 ACR
#   4. kubectl set image + rollout status
#   5. curl /health 三连验证
#
# 前提：
#   - 本地 docker login ACR 已做（ACR push 凭证）
#   - 本地 kubeconfig 在 $KUBECONFIG_STAGING（默认 ~/.kube/ivn-staging.yaml），
#     server 字段指向 staging EIP，client cert 在 cert SAN 内
#   - ECS 安全组放开 6443
#
# 用法：
#   ./redeploy.sh                # 用 HEAD 当前 commit
#   TAG=hotfix-debug ./redeploy.sh   # 强制覆盖 tag（罕见，比如 reproduce 老版本）

set -euo pipefail

# ============================================================================
# 配置
# ============================================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
KUBECONFIG_STAGING="${KUBECONFIG_STAGING:-$HOME/.kube/ivn-staging.yaml}"
NAMESPACE="${NAMESPACE:-ivn}"
DEPLOY="${DEPLOY:-ivn-engine}"
HEALTH_URL="${HEALTH_URL:-http://39.108.85.114:30001/health}"
PULL_IMAGE_BASE="${PULL_IMAGE_BASE:-memoryx-registry-registry-vpc.cn-shenzhen.cr.aliyuncs.com/ivn/engine}"

# 颜色
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}[info]${NC}  $1"; }
warn()  { echo -e "${YELLOW}[warn]${NC}  $1"; }
die()   { echo -e "${RED}[err]${NC}   $1"; exit 1; }

# ============================================================================
# 前置检查
# ============================================================================
[[ -f "$KUBECONFIG_STAGING" ]] || die "kubeconfig 不存在: $KUBECONFIG_STAGING（先按 ops/k3s-pressuretest/SETUP.md 配好直连）"
command -v docker >/dev/null   || die "docker 不在 PATH"
command -v kubectl >/dev/null  || die "kubectl 不在 PATH"
command -v git >/dev/null      || die "git 不在 PATH"
command -v curl >/dev/null     || die "curl 不在 PATH"

cd "$REPO_ROOT"

# git tree 必须干净 —— 防止 "本地改了没提交但发的是旧 commit 的镜像" 这种迷惑
if [[ -n "$(git status --porcelain)" ]]; then
  die "工作树不干净，先 commit 或 stash 再发版（避免镜像内容和 git tag 不一致）"
fi

# ============================================================================
# 计算 tag
# ============================================================================
SHORT_SHA="$(git rev-parse --short HEAD)"
TIMESTAMP="$(date -u +%Y%m%d-%H%M%S)"
TAG="${TAG:-${TIMESTAMP}-${SHORT_SHA}}"
PULL_IMAGE="${PULL_IMAGE_BASE}:${TAG}"

info "tag:         $TAG"
info "pull image:  $PULL_IMAGE"
info "kubeconfig:  $KUBECONFIG_STAGING"
info "deploy:      $NAMESPACE/$DEPLOY"

# ============================================================================
# 1. build + push
# ============================================================================
info "build + push 镜像（调 build-and-push.sh）..."
bash "$SCRIPT_DIR/build-and-push.sh" "$TAG"

# ============================================================================
# 2. set image + rollout status
# ============================================================================
export KUBECONFIG="$KUBECONFIG_STAGING"

info "kubectl set image..."
kubectl -n "$NAMESPACE" set image "deploy/$DEPLOY" "server=$PULL_IMAGE"

info "等 rollout..."
if ! kubectl -n "$NAMESPACE" rollout status "deploy/$DEPLOY" --timeout=180s; then
  warn "rollout 超时 / 失败，看 pod 状态："
  kubectl -n "$NAMESPACE" get pods -l "app=$DEPLOY" -o wide
  kubectl -n "$NAMESPACE" describe pods -l "app=$DEPLOY" | tail -40
  die "rollout 没成功，请人工介入"
fi

# ============================================================================
# 3. 验证
# ============================================================================
info "当前 pod 状态："
kubectl -n "$NAMESPACE" get pods -l "app=$DEPLOY" -o wide

CURRENT_IMAGE="$(kubectl -n "$NAMESPACE" get deploy "$DEPLOY" -o jsonpath='{.spec.template.spec.containers[0].image}')"
[[ "$CURRENT_IMAGE" == "$PULL_IMAGE" ]] \
  || die "image 没切到目标 tag: 期望 $PULL_IMAGE，实际 $CURRENT_IMAGE"
info "image 已切：$CURRENT_IMAGE"

info "curl /health 三连..."
for i in 1 2 3; do
  if ! curl -sf --max-time 5 "$HEALTH_URL" > /dev/null; then
    warn "/health 第 $i 次失败"
  else
    info "  /health #$i OK"
  fi
done

echo
echo -e "${GREEN}==========================================${NC}"
echo -e "${GREEN}✅ rollout 完成${NC}"
echo "  tag:    $TAG"
echo "  image:  $PULL_IMAGE"
echo "  公网:    ${HEALTH_URL%/health}/"
echo -e "${GREEN}==========================================${NC}"
