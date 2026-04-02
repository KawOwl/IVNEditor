#!/usr/bin/env bash
#
# IVN Editor 部署脚本
# 用法：sudo bash deploy.sh
#
# 自动完成：
#   1. 检测项目路径、bun/pnpm 路径、当前用户
#   2. 安装依赖 + 构建前端
#   3. 创建 systemd service
#   4. 启动服务
#

set -e

# ============================================================================
# 颜色输出
# ============================================================================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# ============================================================================
# 检测环境
# ============================================================================

# 项目路径：脚本所在目录
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$PROJECT_DIR/server"

info "项目路径: $PROJECT_DIR"

# 检测调用者（sudo 下取 SUDO_USER）
if [ -n "$SUDO_USER" ]; then
  RUN_USER="$SUDO_USER"
else
  RUN_USER="$(whoami)"
fi
[ "$RUN_USER" = "root" ] && error "请勿以 root 用户运行项目，使用 sudo bash deploy.sh（以普通用户的 sudo）"
info "运行用户: $RUN_USER"

# 获取用户的 HOME（sudo 下 $HOME 可能是 /root）
RUN_HOME=$(getent passwd "$RUN_USER" | cut -d: -f6)

# 检测 bun
BUN_PATH=""
for candidate in \
  "$(su - "$RUN_USER" -c 'which bun' 2>/dev/null)" \
  "$RUN_HOME/.bun/bin/bun" \
  "/usr/local/bin/bun" \
  "/usr/bin/bun"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    BUN_PATH="$candidate"
    break
  fi
done
[ -z "$BUN_PATH" ] && error "找不到 bun，请先安装: curl -fsSL https://bun.sh/install | bash"
info "Bun 路径: $BUN_PATH"

# 检测 pnpm
PNPM_PATH=""
for candidate in \
  "$(su - "$RUN_USER" -c 'which pnpm' 2>/dev/null)" \
  "$RUN_HOME/.local/share/pnpm/pnpm" \
  "/usr/local/bin/pnpm" \
  "/usr/bin/pnpm"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    PNPM_PATH="$candidate"
    break
  fi
done
[ -z "$PNPM_PATH" ] && error "找不到 pnpm，请先安装: npm install -g pnpm"
info "pnpm 路径: $PNPM_PATH"

# 检测 node（pnpm 需要）
NODE_PATH=""
for candidate in \
  "$(su - "$RUN_USER" -c 'which node' 2>/dev/null)" \
  "$RUN_HOME/.nvm/versions/node/$(ls "$RUN_HOME/.nvm/versions/node/" 2>/dev/null | tail -1)/bin/node" \
  "/usr/local/bin/node" \
  "/usr/bin/node"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    NODE_PATH="$candidate"
    break
  fi
done
[ -z "$NODE_PATH" ] && error "找不到 node，请先安装"
NODE_DIR="$(dirname "$NODE_PATH")"
info "Node 路径: $NODE_PATH"

# 检查关键文件
[ ! -f "$PROJECT_DIR/package.json" ] && error "项目目录缺少 package.json"
[ ! -f "$SERVER_DIR/package.json" ] && error "server/ 目录缺少 package.json"

# ============================================================================
# 端口配置
# ============================================================================
PORT="${PORT:-3001}"
info "服务端口: $PORT"

# ============================================================================
# 安装依赖 + 构建
# ============================================================================
info "安装前端依赖..."
su - "$RUN_USER" -c "cd '$PROJECT_DIR' && '$PNPM_PATH' install"

info "构建前端..."
su - "$RUN_USER" -c "cd '$PROJECT_DIR' && '$PNPM_PATH' build"

info "安装后端依赖..."
su - "$RUN_USER" -c "cd '$SERVER_DIR' && '$BUN_PATH' install"

[ ! -d "$PROJECT_DIR/dist" ] && error "构建失败，dist/ 目录不存在"
info "前端构建成功: $PROJECT_DIR/dist"

# ============================================================================
# 创建 .env（如果不存在）
# ============================================================================
if [ ! -f "$SERVER_DIR/.env" ]; then
  if [ -f "$SERVER_DIR/.env.example" ]; then
    cp "$SERVER_DIR/.env.example" "$SERVER_DIR/.env"
    chown "$RUN_USER":"$RUN_USER" "$SERVER_DIR/.env"
    warn "已从 .env.example 创建 server/.env，请编辑填入 LLM_API_KEY 等配置"
    warn "  nano $SERVER_DIR/.env"
  else
    warn "server/.env 不存在且无 .env.example，服务可能缺少 LLM 配置"
  fi
fi

# ============================================================================
# 创建 systemd service
# ============================================================================
SERVICE_NAME="ivn-editor"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

# 构建 PATH：确保 bun、node、pnpm 都在 PATH 中
SVC_PATH="$(dirname "$BUN_PATH"):$NODE_DIR:$(dirname "$PNPM_PATH"):/usr/local/bin:/usr/bin:/bin"

info "创建 systemd service: $SERVICE_FILE"

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=IVN Editor Server (Interactive Visual Novel Engine)
After=network.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$SERVER_DIR
ExecStart=$BUN_PATH run start
Restart=on-failure
RestartSec=5

# 环境变量
Environment=PORT=$PORT
Environment=NODE_ENV=production
Environment=PATH=$SVC_PATH

# 从 .env 加载 LLM 配置
EnvironmentFile=-$SERVER_DIR/.env

# 日志
StandardOutput=journal
StandardError=journal
SyslogIdentifier=$SERVICE_NAME

[Install]
WantedBy=multi-user.target
EOF

info "service 文件已创建"

# ============================================================================
# 启动服务
# ============================================================================
info "重载 systemd 配置..."
systemctl daemon-reload

info "启用开机自启..."
systemctl enable "$SERVICE_NAME"

info "启动服务..."
systemctl restart "$SERVICE_NAME"

# 等待启动
sleep 2

if systemctl is-active --quiet "$SERVICE_NAME"; then
  info "服务启动成功！"
  echo ""
  echo "========================================="
  echo "  IVN Editor 已部署"
  echo "  地址: http://localhost:$PORT"
  echo "========================================="
  echo ""
  echo "常用命令："
  echo "  查看状态:  systemctl status $SERVICE_NAME"
  echo "  查看日志:  journalctl -u $SERVICE_NAME -f"
  echo "  重启服务:  systemctl restart $SERVICE_NAME"
  echo "  停止服务:  systemctl stop $SERVICE_NAME"
  echo ""
  echo "更新部署："
  echo "  cd $PROJECT_DIR && git pull && pnpm build && sudo systemctl restart $SERVICE_NAME"
  echo ""
else
  error "服务启动失败，请检查日志: journalctl -u $SERVICE_NAME -n 50"
fi
