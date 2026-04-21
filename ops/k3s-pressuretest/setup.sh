#!/usr/bin/env bash
#
# k3s 压测环境一键安装脚本
#
# 目标：在一台 ECS 8C32G 上搭起 k3s + Nginx Ingress + Langfuse + IVN 引擎，
#       连已有的阿里云托管 RDS PG / ClickHouse / Redis / OSS。
#
# 前提：
#   - ECS 系统：Alibaba Cloud Linux 3 / Ubuntu 22.04 / CentOS Stream 8+
#   - ECS 在与托管服务相同的 VPC 和可用区（深圳 F）
#   - 已创建 PG database：langfuse 和 ivn（两个 DB 共用同一个 RDS 实例）
#   - 已创建 OSS bucket 和 RAM 子账号
#
# 用法：
#   cd ops/k3s-pressuretest/
#   cp env.example env
#   vim env                   # 填实际连接信息
#   sudo -E bash setup.sh
#
# 清理：
#   sudo /usr/local/bin/k3s-uninstall.sh
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ============================================================
# 颜色
# ============================================================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# ============================================================
# 加载 env
# ============================================================
if [[ -f "$SCRIPT_DIR/env" ]]; then
  # shellcheck disable=SC1091
  set -a; source "$SCRIPT_DIR/env"; set +a
  info "已加载 $SCRIPT_DIR/env"
else
  warn "未找到 $SCRIPT_DIR/env，仅使用 shell 环境变量"
fi

# ============================================================
# 配置校验
# ============================================================
require_var() {
  local name="$1"
  local value="${!name:-}"
  if [[ -z "$value" || "$value" == *"xxx"* || "$value" == "CHANGEME" ]]; then
    error "环境变量 $name 未设置或包含 placeholder（当前值：$value）"
  fi
}

info "== 校验必填配置 =="
require_var PG_HOST
require_var PG_USER
require_var PG_PASSWORD
require_var CH_HOST
require_var CH_USER
require_var CH_PASSWORD
require_var REDIS_HOST
require_var REDIS_PASSWORD
require_var OSS_BUCKET
require_var OSS_ENDPOINT
require_var OSS_AK
require_var OSS_SK
require_var LANGFUSE_INIT_USER_PASSWORD
require_var IVN_IMAGE

# 生成动态 secrets（未指定时）
LANGFUSE_NEXTAUTH_SECRET="${LANGFUSE_NEXTAUTH_SECRET:-$(openssl rand -hex 32)}"
LANGFUSE_SALT="${LANGFUSE_SALT:-$(openssl rand -hex 32)}"
LANGFUSE_ENCRYPTION_KEY="${LANGFUSE_ENCRYPTION_KEY:-$(openssl rand -hex 32)}"

info "配置完整"

# ============================================================
# Step 1: 安装 k3s（禁用内置 Traefik / servicelb）
# ============================================================
if ! command -v k3s &>/dev/null; then
  info "== 安装 k3s =="
  curl -sfL https://get.k3s.io | \
    INSTALL_K3S_EXEC="--disable traefik --disable servicelb --write-kubeconfig-mode 644" \
    sh -
else
  info "k3s 已存在，跳过安装"
fi

export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
ln -sf /var/lib/rancher/k3s/bin/kubectl /usr/local/bin/kubectl 2>/dev/null || true

info "等待 k3s 就绪..."
for i in {1..30}; do
  if kubectl get nodes &>/dev/null; then break; fi
  sleep 2
done
kubectl wait --for=condition=Ready node --all --timeout=120s
kubectl get nodes

# ============================================================
# Step 2: 安装 Helm
# ============================================================
if ! command -v helm &>/dev/null; then
  info "== 安装 Helm =="
  curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
fi
info "Helm: $(helm version --short)"

# ============================================================
# Step 3: 安装 Nginx Ingress
# ============================================================
if ! kubectl get ns ingress-nginx &>/dev/null; then
  info "== 安装 Nginx Ingress =="
  helm install ingress-nginx ingress-nginx \
    --repo https://kubernetes.github.io/ingress-nginx \
    --namespace ingress-nginx --create-namespace \
    --set controller.service.type=NodePort \
    --set controller.service.nodePorts.http=30080 \
    --set controller.service.nodePorts.https=30443 \
    --set controller.resources.requests.cpu=200m \
    --set controller.resources.requests.memory=256Mi \
    --set controller.config.proxy-body-size="10m" \
    --set controller.config.proxy-read-timeout="3600" \
    --set controller.config.proxy-send-timeout="3600"
  kubectl wait --for=condition=ready pod \
    -l app.kubernetes.io/component=controller \
    -n ingress-nginx --timeout=180s
else
  info "Nginx Ingress 已存在"
fi

# ============================================================
# Step 4: namespace
# ============================================================
kubectl apply -f - <<EOF
apiVersion: v1
kind: Namespace
metadata: { name: langfuse }
---
apiVersion: v1
kind: Namespace
metadata: { name: ivn }
EOF

# ============================================================
# Step 5: Langfuse secret
# ============================================================
info "== 创建 langfuse-backend secret =="
kubectl -n langfuse delete secret langfuse-backend --ignore-not-found
kubectl -n langfuse create secret generic langfuse-backend \
  --from-literal=DATABASE_URL="postgresql://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT:-5432}/${PG_LANGFUSE_DB:-langfuse}?sslmode=require" \
  --from-literal=CLICKHOUSE_URL="https://${CH_HOST}:8443" \
  --from-literal=CLICKHOUSE_MIGRATION_URL="clickhouse://${CH_HOST}:9000" \
  --from-literal=CLICKHOUSE_USER="${CH_USER}" \
  --from-literal=CLICKHOUSE_PASSWORD="${CH_PASSWORD}" \
  --from-literal=CLICKHOUSE_CLUSTER_ENABLED="false" \
  --from-literal=REDIS_CONNECTION_STRING="rediss://default:${REDIS_PASSWORD}@${REDIS_HOST}:${REDIS_PORT:-6379}/0" \
  --from-literal=LANGFUSE_S3_EVENT_UPLOAD_BUCKET="${OSS_BUCKET}" \
  --from-literal=LANGFUSE_S3_EVENT_UPLOAD_REGION="${OSS_REGION:-cn-shenzhen}" \
  --from-literal=LANGFUSE_S3_EVENT_UPLOAD_ENDPOINT="https://${OSS_ENDPOINT}" \
  --from-literal=LANGFUSE_S3_EVENT_UPLOAD_ACCESS_KEY_ID="${OSS_AK}" \
  --from-literal=LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY="${OSS_SK}" \
  --from-literal=LANGFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE="true" \
  --from-literal=LANGFUSE_S3_EVENT_UPLOAD_PREFIX="events/" \
  --from-literal=LANGFUSE_S3_MEDIA_UPLOAD_BUCKET="${OSS_BUCKET}" \
  --from-literal=LANGFUSE_S3_MEDIA_UPLOAD_REGION="${OSS_REGION:-cn-shenzhen}" \
  --from-literal=LANGFUSE_S3_MEDIA_UPLOAD_ENDPOINT="https://${OSS_ENDPOINT}" \
  --from-literal=LANGFUSE_S3_MEDIA_UPLOAD_ACCESS_KEY_ID="${OSS_AK}" \
  --from-literal=LANGFUSE_S3_MEDIA_UPLOAD_SECRET_ACCESS_KEY="${OSS_SK}" \
  --from-literal=LANGFUSE_S3_MEDIA_UPLOAD_FORCE_PATH_STYLE="true" \
  --from-literal=LANGFUSE_S3_MEDIA_UPLOAD_PREFIX="media/" \
  --from-literal=NEXTAUTH_SECRET="${LANGFUSE_NEXTAUTH_SECRET}" \
  --from-literal=SALT="${LANGFUSE_SALT}" \
  --from-literal=ENCRYPTION_KEY="${LANGFUSE_ENCRYPTION_KEY}" \
  --from-literal=LANGFUSE_INIT_USER_EMAIL="${LANGFUSE_INIT_USER_EMAIL:-admin@example.com}" \
  --from-literal=LANGFUSE_INIT_USER_PASSWORD="${LANGFUSE_INIT_USER_PASSWORD}" \
  --from-literal=LANGFUSE_INIT_USER_NAME="${LANGFUSE_INIT_USER_NAME:-Admin}"

# ============================================================
# Step 6: 部署 Langfuse（Helm chart）
# ============================================================
info "== 部署 Langfuse =="
helm repo add langfuse https://langfuse.github.io/langfuse-k8s 2>/dev/null || true
helm repo update langfuse

helm upgrade --install langfuse langfuse/langfuse \
  --namespace langfuse \
  --values "$SCRIPT_DIR/langfuse-values.yaml" \
  --wait --timeout 10m || warn "Langfuse helm 安装超时或失败，检查 kubectl -n langfuse logs"

kubectl -n langfuse get pods

# ============================================================
# Step 7: IVN 引擎
# ============================================================
info "== 创建 ivn-backend secret =="
kubectl -n ivn delete secret ivn-backend --ignore-not-found

# 首次部署时 Langfuse 还没有 project → 留空 key，事后人工更新
kubectl -n ivn create secret generic ivn-backend \
  --from-literal=DATABASE_URL="postgresql://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT:-5432}/${PG_IVN_DB:-ivn}?sslmode=require" \
  --from-literal=LANGFUSE_HOST="http://langfuse-web.langfuse.svc.cluster.local:3000" \
  --from-literal=LANGFUSE_PUBLIC_KEY="${LANGFUSE_PUBLIC_KEY:-}" \
  --from-literal=LANGFUSE_SECRET_KEY="${LANGFUSE_SECRET_KEY:-}" \
  --from-literal=ADMIN_USERS="${IVN_ADMIN_USERS}" \
  --from-literal=PG_POOL_MAX="${PG_POOL_MAX:-40}" \
  --from-literal=NODE_ENV="production" \
  `# M4 asset pipeline - 复用 Langfuse 那套 OSS 凭证，bucket 里 IVN 写 scripts/ 前缀，` \
  `# 和 Langfuse 的 events/ media/ 前缀自然分开不冲突` \
  --from-literal=S3_ENDPOINT="https://${OSS_ENDPOINT}" \
  --from-literal=S3_REGION="${OSS_REGION:-cn-shenzhen}" \
  --from-literal=S3_ACCESS_KEY_ID="${OSS_AK}" \
  --from-literal=S3_SECRET_ACCESS_KEY="${OSS_SK}" \
  --from-literal=S3_BUCKET="${OSS_BUCKET}" \
  `# 阿里云 OSS 必须 false（virtual-hosted-style），MinIO dev 才 true` \
  --from-literal=S3_FORCE_PATH_STYLE="false" \
  `# LLM：服务端做 bootstrap 种子（server 启动时若 llm_configs 表空就用这些建默认 config）` \
  --from-literal=LLM_PROVIDER="${LLM_PROVIDER:-openai-compatible}" \
  --from-literal=LLM_BASE_URL="${LLM_BASE_URL:-https://api.deepseek.com/v1}" \
  --from-literal=LLM_API_KEY="${LLM_API_KEY:-}" \
  --from-literal=LLM_MODEL="${LLM_MODEL:-deepseek-chat}" \
  --from-literal=LLM_NAME="${LLM_NAME:-deepseek}"

info "== 创建 ACR 拉取凭证 =="
if [[ -n "${ACR_USERNAME:-}" && -n "${ACR_PASSWORD:-}" && -n "${ACR_SERVER:-}" ]]; then
  kubectl -n ivn delete secret acr-credentials --ignore-not-found
  kubectl -n ivn create secret docker-registry acr-credentials \
    --docker-server="${ACR_SERVER}" \
    --docker-username="${ACR_USERNAME}" \
    --docker-password="${ACR_PASSWORD}"
else
  warn "ACR_USERNAME/ACR_PASSWORD/ACR_SERVER 未配置，跳过 acr-credentials。如 IVN_IMAGE 是私有 ACR 镜像会导致 ImagePullBackOff"
fi

info "== 部署 IVN 引擎 =="
sed "s|__IVN_IMAGE__|${IVN_IMAGE}|g" "$SCRIPT_DIR/ivn-manifests.yaml" | kubectl apply -f -

kubectl -n ivn rollout status deployment/ivn-engine --timeout=180s || \
  warn "IVN 引擎未就绪，检查 kubectl -n ivn logs"

kubectl -n ivn get pods

# ============================================================
# 完成
# ============================================================
ECS_IP=$(curl -s --max-time 3 http://100.100.100.200/latest/meta-data/eipv4 2>/dev/null \
     || curl -s --max-time 3 http://100.100.100.200/latest/meta-data/public-ipv4 2>/dev/null \
     || hostname -I | awk '{print $1}' \
     || echo "YOUR_ECS_IP")

cat <<EOF

${GREEN}==========================================${NC}
${GREEN}✅ 部署完成${NC}

压测访问入口（HTTP）:
  Langfuse UI:  http://${ECS_IP}:30080/
  IVN 引擎:     http://${ECS_IP}:30080/  (需要修改 Host header 或配 /etc/hosts)

首次设置步骤:
  1. 用 curl -H 'Host: langfuse.local' 或在本地 hosts 加
     ${ECS_IP} langfuse.local ivn.local
     访问 http://langfuse.local:30080/
  2. 用 ${LANGFUSE_INIT_USER_EMAIL:-admin@example.com} 登录
  3. UI 里创建 organization + project，获取 pk-lf-xxx 和 sk-lf-xxx
  4. 更新 IVN secret：
     kubectl -n ivn create secret generic ivn-backend \\
       --from-literal=LANGFUSE_PUBLIC_KEY='pk-lf-xxx' \\
       --from-literal=LANGFUSE_SECRET_KEY='sk-lf-xxx' \\
       --from-literal=... (保留其他字段) \\
       --dry-run=client -o yaml | kubectl apply -f -
  5. 滚动重启：
     kubectl -n ivn rollout restart deployment/ivn-engine
  6. 运行压测：
     BASE_URL=http://${ECS_IP}:30080 k6 run loadtest.js

查看状态:
  kubectl get pods -A
  kubectl -n ivn logs -f deploy/ivn-engine
  kubectl -n langfuse logs -f deploy/langfuse-web

清理:
  /usr/local/bin/k3s-uninstall.sh
${GREEN}==========================================${NC}
EOF
