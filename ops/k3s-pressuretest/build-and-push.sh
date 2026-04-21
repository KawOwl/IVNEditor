#!/usr/bin/env bash
#
# 构建并推送 IVN 引擎镜像到阿里云 ACR
#
# 两个 endpoint（企业版 ACR 格式：<instance>-registry.<region>.cr.aliyuncs.com）：
#   公网：  memoryx-registry-registry.cn-shenzhen.cr.aliyuncs.com       — 本地 push
#   VPC：   memoryx-registry-registry-vpc.cn-shenzhen.cr.aliyuncs.com   — ECS pull（免流量）
# 同一个镜像两个 endpoint 共享，push 到公网后 VPC 也能立刻 pull。
#
# 个人版 ACR 用的是 `registry.cn-shenzhen.aliyuncs.com`（没有实例前缀、
# 没有 `.cr.`），改 REGISTRY_PUSH/REGISTRY_PULL 覆盖即可。
#
# 用法：
#   cd ops/k3s-pressuretest/
#   ./build-and-push.sh v2
#
# 首次：
#   docker login memoryx-registry-registry.cn-shenzhen.cr.aliyuncs.com
#   （账号用 ACR 访问凭证的用户名；密码是 ACR 控制台设的"固定密码"）

set -euo pipefail

TAG="${1:-latest}"

# 公网 / VPC endpoint（企业版 ACR）
REGISTRY_PUSH="${REGISTRY_PUSH:-memoryx-registry-registry.cn-shenzhen.cr.aliyuncs.com}"
REGISTRY_PULL="${REGISTRY_PULL:-memoryx-registry-registry-vpc.cn-shenzhen.cr.aliyuncs.com}"

# 命名空间 + repo（按你实际的 ACR 配置）
NAMESPACE="${NAMESPACE:-ivn-prod}"
REPO="${REPO:-engine}"

PUSH_IMAGE="${REGISTRY_PUSH}/${NAMESPACE}/${REPO}:${TAG}"
PULL_IMAGE="${REGISTRY_PULL}/${NAMESPACE}/${REPO}:${TAG}"

# 项目根目录 = 本脚本所在目录的上上层
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

echo "[build] 镜像（本地 tag）: $PUSH_IMAGE"
echo "[build] context:          $(pwd)"

# 开 BuildKit（默认已开，保险 export 一下）—— 分层 cache + --mount=type=cache 必需
export DOCKER_BUILDKIT=1

docker build \
  --tag "$PUSH_IMAGE" \
  --progress=plain \
  --platform linux/amd64 \
  .

echo ""
echo "[build] 镜像分层："
docker history "$PUSH_IMAGE" --format "table {{.ID}}\t{{.Size}}\t{{.CreatedBy}}" | head -20

echo ""
echo "[push] 推送到公网 endpoint: $PUSH_IMAGE"
docker push "$PUSH_IMAGE"

echo ""
echo "✅ 完成"
echo ""
echo "两个地址（同一个 image，两个 DNS）："
echo "  公网（本地 pull / push）: $PUSH_IMAGE"
echo "  VPC（ECS pull，免流量）: $PULL_IMAGE"
echo ""
echo "下一步："
echo "  1. 更新 ops/k3s-pressuretest/env: IVN_IMAGE=$PULL_IMAGE"
echo "     （k3s manifests 里用 VPC 地址，ECS pull 免流量费）"
echo "  2. 在 ECS 上: sudo -E bash setup.sh"
echo "     或仅更新镜像: kubectl -n ivn set image deploy/ivn-engine server=$PULL_IMAGE"
