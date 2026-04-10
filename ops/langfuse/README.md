# Langfuse 自部署

IVN 项目的可观测性基础设施。

## 为什么自部署

- **隐私**：玩家输入、LLM 输出、prompt 全量上报，不能发到第三方
- **免费**：Langfuse OSS 版本功能完整，无 events 数量限制
- **掌控**：随时可以 `docker compose down -v` 清掉所有数据，或导出

## 组件

- `langfuse-web` — Web UI + ingestion API（**对外暴露唯一端口**，默认 3000）
- `langfuse-worker` — 后台任务处理
- `postgres` — Langfuse 自己的 OLTP（和业务 postgres17 隔离）
- `clickhouse` — trace 分析的 OLAP 存储
- `redis` — 队列 + 缓存
- `minio` — S3 兼容的对象存储（event/media 上传用）

所有内部服务都**不对宿主机暴露端口**，仅通过 docker 网络通信。

## 首次部署

```bash
cd ops/langfuse

# 1. 拷贝并填写环境变量
cp .env.example .env

# 2. 生成所有随机密钥
#    把输出填进 .env 对应字段
echo "SALT=$(openssl rand -hex 16)"
echo "ENCRYPTION_KEY=$(openssl rand -hex 32)"
echo "NEXTAUTH_SECRET=$(openssl rand -hex 32)"
echo "POSTGRES_PASSWORD=$(openssl rand -base64 24 | tr -d '=+/')"
echo "CLICKHOUSE_PASSWORD=$(openssl rand -base64 24 | tr -d '=+/')"
echo "REDIS_AUTH=$(openssl rand -base64 24 | tr -d '=+/')"
echo "MINIO_ROOT_PASSWORD=$(openssl rand -base64 24 | tr -d '=+/')"
echo "LANGFUSE_INIT_USER_PASSWORD=$(openssl rand -base64 18 | tr -d '=+/')"
echo "LANGFUSE_INIT_PROJECT_PUBLIC_KEY=pk-lf-ivn-$(openssl rand -hex 8)"
echo "LANGFUSE_INIT_PROJECT_SECRET_KEY=sk-lf-ivn-$(openssl rand -hex 16)"

# 3. 设置 NEXTAUTH_URL 为你的服务器地址
#    LANGFUSE_WEB_PORT 想改也在这里改
#    .env 里填好上述全部值

# 4. 启动
docker compose up -d

# 5. 等服务就绪（1-2 分钟）
docker compose ps
docker compose logs -f langfuse-web

# 6. 首次启动完成后:
#    - 访问 http://<host>:3000
#    - 用 LANGFUSE_INIT_USER_EMAIL / PASSWORD 登录
#    - Project 和 API key 已经自动创建，直接用就行
```

## 接入业务代码

把 `LANGFUSE_INIT_PROJECT_PUBLIC_KEY` / `SECRET_KEY` / `NEXTAUTH_URL`
填到 **server/.env** 的对应字段：

```env
# server/.env
LANGFUSE_HOST=http://your-server-ip:3000
LANGFUSE_PUBLIC_KEY=pk-lf-ivn-xxx
LANGFUSE_SECRET_KEY=sk-lf-ivn-yyy
```

## 日常运维

```bash
# 查看状态
docker compose ps

# 查看日志
docker compose logs -f langfuse-web
docker compose logs -f langfuse-worker

# 停止（保留数据）
docker compose down

# 启动
docker compose up -d

# 重启某个服务
docker compose restart langfuse-web

# ⚠️ 完全清除所有数据
docker compose down -v
```

## 升级

```bash
docker compose pull
docker compose up -d
```

首次启动自动应用 DB migration。升级失败先看 `docker compose logs langfuse-worker`。

## 备份

Langfuse 主要数据在两个地方：
1. Langfuse 自己的 postgres（用户、项目、配置）
2. Clickhouse（trace 数据）

```bash
# Postgres 备份
docker compose exec postgres pg_dump -U postgres postgres > langfuse-pg-$(date +%Y%m%d).sql

# Clickhouse 备份（导出所有表）
docker compose exec clickhouse clickhouse-client --password $CLICKHOUSE_PASSWORD \
  -q "BACKUP DATABASE default TO File('/var/lib/clickhouse/backups/backup-$(date +%Y%m%d)')"
```

## 故障排查

**Web UI 502 / Connection refused**
- `docker compose logs langfuse-web` 看报错
- 90% 是 postgres/clickhouse 还没 ready，等几十秒
- 检查所有 healthcheck: `docker compose ps`

**Worker 大量 error 日志**
- 通常是 clickhouse 迁移失败
- `docker compose down && docker compose up -d` 重新拉起

**数据上传但 dashboard 看不到**
- Langfuse 批处理上报，延迟 5-10 秒正常
- 检查 SDK 配置的 baseUrl 是否匹配 `NEXTAUTH_URL`
- 检查 API key 是否正确
