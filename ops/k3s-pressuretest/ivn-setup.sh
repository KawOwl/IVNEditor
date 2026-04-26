#!/usr/bin/env bash
#
# ivn-setup.sh — 只部署 IVN 引擎（不碰已有 Langfuse）
#
# 前提：
#   1. k3s 已装、Langfuse 已跑（kubectl 可用）
#   2. langfuse-env secret 存在（从里面抽 RDS / OSS 凭证复用）
#   3. RDS 里已经 CREATE DATABASE $IVN_DB_NAME（默认 ivn_test）
#   4. ACR 访问凭证通过 ACR_USERNAME / ACR_PASSWORD 环境变量传入
#   5. 目标 image 已 push 到 ACR（用 build-and-push.sh）
#
# 用法：
#   ACR_USERNAME=xxx ACR_PASSWORD=xxx \
#   IVN_PG_USER=ivn_user IVN_PG_PASSWORD='xxx' \
#   bash ivn-setup.sh
#
# 必填环境变量：
#   IVN_PG_USER      IVN 在 RDS 里的 PG 用户名（和 Langfuse 不一样，独立账号）
#   IVN_PG_PASSWORD  对应密码（里面有特殊字符不用手动转义，脚本会 URL-encode）
#
# 可选环境变量：
#   IVN_IMAGE        默认 memoryx-registry-registry-vpc.cn-shenzhen.cr.aliyuncs.com/ivn/engine:v2
#   IVN_DB_NAME      默认 ivn_test
#   IVN_PG_HOST      默认从 langfuse-env 抽（同一个 RDS 实例）
#   IVN_PG_PORT      默认从 langfuse-env 抽（通常 5432）
#   IVN_PG_SSLMODE   默认 require
#   NODE_PORT        默认 30081（对外访问端口）
#   ACR_SERVER       默认 memoryx-registry-registry-vpc.cn-shenzhen.cr.aliyuncs.com
#
#   # 长期记忆 adapter（剧本 memoryConfig.provider 选 'mem0' / 'memorax' /
#   # 'parallel' 时必填对应那套；缺失则 createMemory 抛错。空串等同未设置：
#   # spec/env.mts 的 emptyToUndefined 会归一化）
#   MEM0_API_KEY        mem0 云端托管向量检索的 API key
#   MEMORAX_BASE_URL    self-hosted Memorax 后端 URL，例 http://47.99.179.197
#   MEMORAX_API_KEY     Memorax 业务 API key（sk_ 开头）
#   MEMORAX_APP_ID      Memorax app_id 命名空间，默认 ivn-editor

set -euo pipefail

# ============================================================
# Config
# ============================================================
IVN_IMAGE="${IVN_IMAGE:-memoryx-registry-registry-vpc.cn-shenzhen.cr.aliyuncs.com/ivn/engine:v2}"
IVN_DB_NAME="${IVN_DB_NAME:-ivn_test}"
NODE_PORT="${NODE_PORT:-30001}"
ACR_SERVER="${ACR_SERVER:-memoryx-registry-registry-vpc.cn-shenzhen.cr.aliyuncs.com}"
ADMIN_CREDS_FILE="${ADMIN_CREDS_FILE:-$HOME/ivn-admin-credentials.txt}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 颜色
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}[info]${NC}  $1"; }
warn()  { echo -e "${YELLOW}[warn]${NC}  $1"; }
die()   { echo -e "${RED}[err]${NC}   $1"; exit 1; }

# ============================================================
# kubectl
# ============================================================
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
command -v kubectl >/dev/null || die "kubectl 不在 PATH"
kubectl cluster-info >/dev/null 2>&1 || die "连不上 k3s cluster"

# ============================================================
# 从 langfuse-env 抽凭证（复用）
# ============================================================
info "从 langfuse-env secret 读共享凭证（RDS + OSS）"
kubectl -n langfuse get secret langfuse-env >/dev/null 2>&1 \
  || die "找不到 langfuse-env secret。先装好 Langfuse 再跑本脚本"

get_lf() {
  kubectl -n langfuse get secret langfuse-env -o json \
    | python3 -c "import json,sys,base64; d=json.load(sys.stdin); v=d.get('data',{}).get('$1'); print(base64.b64decode(v).decode() if v else '')"
}

# --- IVN 的 PG 凭证（用户必填；和 Langfuse 不同账号）---
[[ -n "${IVN_PG_USER:-}" ]]     || die "IVN_PG_USER 未设置。例：IVN_PG_USER=ivn_test_user bash ivn-setup.sh"
[[ -n "${IVN_PG_PASSWORD:-}" ]] || die "IVN_PG_PASSWORD 未设置"

# --- PG host/port：没传就从 langfuse-env 抽（同一个 RDS 实例）---
LF_DATABASE_URL=$(get_lf DATABASE_URL)
[[ -n "$LF_DATABASE_URL" ]] || die "langfuse-env.DATABASE_URL 为空"

IVN_PG_HOST="${IVN_PG_HOST:-$(echo "$LF_DATABASE_URL" | python3 -c "import sys, urllib.parse as u; print(u.urlparse(sys.stdin.read().strip()).hostname)")}"
IVN_PG_PORT="${IVN_PG_PORT:-$(echo "$LF_DATABASE_URL" | python3 -c "import sys, urllib.parse as u; print(u.urlparse(sys.stdin.read().strip()).port or 5432)")}"
IVN_PG_SSLMODE="${IVN_PG_SSLMODE:-require}"

# 构造 DATABASE_URL：USER 和 PASSWORD 做 URL-encode（防 @ # $ % 等特殊字符）
IVN_DATABASE_URL=$(python3 <<EOF
import urllib.parse as u
user = u.quote("$IVN_PG_USER", safe="")
password = u.quote("$IVN_PG_PASSWORD", safe="")
print(f"postgresql://{user}:{password}@$IVN_PG_HOST:$IVN_PG_PORT/$IVN_DB_NAME?sslmode=$IVN_PG_SSLMODE")
EOF
)

OSS_AK=$(get_lf LANGFUSE_S3_EVENT_UPLOAD_ACCESS_KEY_ID)
OSS_SK=$(get_lf LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY)
OSS_BUCKET=$(get_lf LANGFUSE_S3_EVENT_UPLOAD_BUCKET)
OSS_REGION=$(get_lf LANGFUSE_S3_EVENT_UPLOAD_REGION)
OSS_ENDPOINT=$(get_lf LANGFUSE_S3_EVENT_UPLOAD_ENDPOINT)
[[ -n "$OSS_AK" && -n "$OSS_BUCKET" && -n "$OSS_ENDPOINT" ]] \
  || die "langfuse-env 里 OSS 凭证不全"

LF_PUBLIC=$(get_lf LANGFUSE_INIT_PROJECT_PUBLIC_KEY)
LF_SECRET=$(get_lf LANGFUSE_INIT_PROJECT_SECRET_KEY)

# ============================================================
# admin 密码：存在就复用，没有就新生成
# ============================================================
if [[ -f "$ADMIN_CREDS_FILE" ]]; then
  info "复用已有 admin 凭证：$ADMIN_CREDS_FILE"
  IVN_ADMIN_PASSWORD=$(grep -E '^password:' "$ADMIN_CREDS_FILE" | awk '{print $2}')
  [[ -n "$IVN_ADMIN_PASSWORD" ]] || die "无法从 $ADMIN_CREDS_FILE 解析出密码"
else
  IVN_ADMIN_PASSWORD=$(openssl rand -hex 16)
  cat > "$ADMIN_CREDS_FILE" <<EOF
# IVN admin credentials (generated $(date -Iseconds))
# ⚠️  千万不要上传这个文件到 git / 公开分享
username: admin
password: $IVN_ADMIN_PASSWORD
EOF
  chmod 600 "$ADMIN_CREDS_FILE"
  info "新生成 admin 密码 → $ADMIN_CREDS_FILE"
fi

# ============================================================
# namespace
# ============================================================
info "确保 namespace ivn 存在"
kubectl create namespace ivn --dry-run=client -o yaml | kubectl apply -f - >/dev/null

# ============================================================
# ivn-backend secret
# ============================================================
info "重建 ivn-backend secret（每次 rerun 都全量覆盖）"
kubectl -n ivn delete secret ivn-backend --ignore-not-found >/dev/null

kubectl -n ivn create secret generic ivn-backend \
  --from-literal=DATABASE_URL="$IVN_DATABASE_URL" \
  `# 阿里云 RDS 默认没开 SSL 端口，就算 URL 写 sslmode=require 也连不上。` \
  `# PG_SSL=off 会让 server/src/db/index.ts 显式用 ssl:false，而且把 URL 里的` \
  `# sslmode= 剥掉避免 pg-connection-string 解析成 verify-full。` \
  --from-literal=PG_SSL="off" \
  --from-literal=LANGFUSE_HOST="http://langfuse-web.langfuse.svc.cluster.local:3000" \
  --from-literal=LANGFUSE_PUBLIC_KEY="$LF_PUBLIC" \
  --from-literal=LANGFUSE_SECRET_KEY="$LF_SECRET" \
  --from-literal=ADMIN_USERS="admin:$IVN_ADMIN_PASSWORD" \
  --from-literal=PG_POOL_MAX="40" \
  --from-literal=NODE_ENV="production" \
  --from-literal=S3_ENDPOINT="$OSS_ENDPOINT" \
  --from-literal=S3_REGION="$OSS_REGION" \
  --from-literal=S3_ACCESS_KEY_ID="$OSS_AK" \
  --from-literal=S3_SECRET_ACCESS_KEY="$OSS_SK" \
  --from-literal=S3_BUCKET="$OSS_BUCKET" \
  --from-literal=S3_FORCE_PATH_STYLE="false" \
  `# 长期记忆 adapter env（mem0 / memorax / parallel；缺失等同未配置）` \
  --from-literal=MEM0_API_KEY="${MEM0_API_KEY:-}" \
  --from-literal=MEMORAX_BASE_URL="${MEMORAX_BASE_URL:-}" \
  --from-literal=MEMORAX_API_KEY="${MEMORAX_API_KEY:-}" \
  --from-literal=MEMORAX_APP_ID="${MEMORAX_APP_ID:-ivn-editor}" \
  >/dev/null

info "  DATABASE_URL    → $IVN_PG_USER@$IVN_PG_HOST:$IVN_PG_PORT/$IVN_DB_NAME"
info "  S3_BUCKET       → $OSS_BUCKET"
info "  LANGFUSE_HOST   → cluster-internal service"
info "  ADMIN_USERS     → admin:$(echo "$IVN_ADMIN_PASSWORD" | cut -c1-4)****"
# memory adapter env 状态：标 set / (unset)，不打 key 本身
_redact() { [[ -n "${1:-}" ]] && echo "set" || echo "(unset)"; }
info "  MEM0_API_KEY    → $(_redact "${MEM0_API_KEY:-}")"
info "  MEMORAX_BASE_URL → ${MEMORAX_BASE_URL:-(unset)}"
info "  MEMORAX_API_KEY → $(_redact "${MEMORAX_API_KEY:-}")"
info "  MEMORAX_APP_ID  → ${MEMORAX_APP_ID:-ivn-editor}"

# ============================================================
# ACR 拉取凭证
# ============================================================
if [[ -n "${ACR_USERNAME:-}" && -n "${ACR_PASSWORD:-}" ]]; then
  info "重建 acr-credentials secret"
  kubectl -n ivn delete secret acr-credentials --ignore-not-found >/dev/null
  kubectl -n ivn create secret docker-registry acr-credentials \
    --docker-server="$ACR_SERVER" \
    --docker-username="$ACR_USERNAME" \
    --docker-password="$ACR_PASSWORD" \
    >/dev/null
else
  if kubectl -n ivn get secret acr-credentials >/dev/null 2>&1; then
    warn "ACR_USERNAME / ACR_PASSWORD 未设置，但 acr-credentials 已存在 → 复用"
  else
    warn "ACR_USERNAME / ACR_PASSWORD 未设置，跳过 acr-credentials"
    warn "  如果 $IVN_IMAGE 是私有镜像会 ImagePullBackOff"
  fi
fi

# ============================================================
# 应用 Deployment + Service + Ingress
# ============================================================
info "应用 ivn-manifests.yaml（image=$IVN_IMAGE）"
sed "s|__IVN_IMAGE__|$IVN_IMAGE|g" "$SCRIPT_DIR/ivn-manifests.yaml" | kubectl apply -f -

# Service 改成 NodePort（这个 staging 集群没装 ingress-nginx，用 NodePort 直接暴露）
info "把 ivn-engine Service patch 成 NodePort $NODE_PORT"
kubectl -n ivn patch svc ivn-engine --type=merge -p "$(cat <<EOF
{
  "spec": {
    "type": "NodePort",
    "ports": [
      { "name": "http", "port": 80, "targetPort": 3000, "nodePort": $NODE_PORT }
    ]
  }
}
EOF
)" >/dev/null

# ============================================================
# 等 rollout
# ============================================================
info "等 deployment/ivn-engine 就绪"
if ! kubectl -n ivn rollout status deployment/ivn-engine --timeout=180s; then
  warn "rollout 超时，看日志 kubectl -n ivn logs -f deploy/ivn-engine"
  kubectl -n ivn describe pods -l app=ivn-engine | tail -30
  exit 1
fi

# ============================================================
# 完成
# ============================================================
ECS_IP=$(curl -s --max-time 3 http://100.100.100.200/latest/meta-data/eipv4 2>/dev/null \
     || curl -s --max-time 3 http://100.100.100.200/latest/meta-data/public-ipv4 2>/dev/null \
     || hostname -I | awk '{print $1}' \
     || echo "<ECS-IP>")

echo
echo -e "${GREEN}==========================================${NC}"
echo -e "${GREEN}✅ IVN 引擎部署完成${NC}"
echo
echo "访问："
echo "  公网：      http://${ECS_IP}:${NODE_PORT}/"
echo "  VPC 内：    http://ivn-engine.ivn.svc.cluster.local/"
echo
echo "admin 凭证："
echo "  $ADMIN_CREDS_FILE"
echo
echo "日志 / 排查："
echo "  kubectl -n ivn get pods"
echo "  kubectl -n ivn logs -f deploy/ivn-engine"
echo "  kubectl -n ivn describe pod -l app=ivn-engine | tail -30"
echo
echo "登录后要做的："
echo "  1. 浏览器开 http://${ECS_IP}:${NODE_PORT}/"
echo "  2. Ctrl+Shift+L 呼登录 → admin / <见凭证文件>"
echo "  3. 编辑器 → 设置 → LLM 配置 → 新增 DeepSeek 或其他 LLM"
echo -e "${GREEN}==========================================${NC}"
