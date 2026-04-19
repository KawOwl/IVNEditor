#!/usr/bin/env bash
#
# 构建并推送 IVN 引擎镜像到阿里云 ACR
#
# 用法：
#   cd ops/k3s-pressuretest/
#   ./build-and-push.sh v1
#   ./build-and-push.sh v2
#
# 首次运行前：
#   docker login registry-vpc.cn-shenzhen.aliyuncs.com
#

set -euo pipefail

TAG="${1:-latest}"
# 按你实际的 ACR 命名空间改
REGISTRY="${REGISTRY:-registry-vpc.cn-shenzhen.aliyuncs.com}"
NAMESPACE="${NAMESPACE:-ivn-prod}"
REPO="${REPO:-engine}"

IMAGE="${REGISTRY}/${NAMESPACE}/${REPO}:${TAG}"

# 项目根目录 = 本脚本所在目录的上上层
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

echo "[build] 镜像: $IMAGE"
echo "[build] context: $(pwd)"

# 开 BuildKit（默认已开，保险 export 一下）—— 分层 cache + --mount=type=cache 必需
export DOCKER_BUILDKIT=1

docker build \
  --tag "$IMAGE" \
  --progress=plain \
  --platform linux/amd64 \
  .

echo ""
echo "[build] 镜像分层："
docker history "$IMAGE" --format "table {{.ID}}\t{{.Size}}\t{{.CreatedBy}}" | head -20

echo ""
echo "[push] 推送到 $IMAGE"
docker push "$IMAGE"

echo ""
echo "✅ 完成: $IMAGE"
echo ""
echo "下一步："
echo "  1. 更新 ops/k3s-pressuretest/env: IVN_IMAGE=$IMAGE"
echo "  2. 在 ECS 上: sudo -E bash setup.sh"
echo "     （或仅更新镜像: kubectl -n ivn set image deploy/ivn-engine server=$IMAGE）"
