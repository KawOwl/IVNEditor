# MinIO 本地 dev

给 M4 asset pipeline 用的 S3 兼容对象存储。生产切阿里云 OSS 只改 server/.env 的 `S3_*` 字段，不改任何代码。

## 启动

```bash
cd ops/minio
docker compose up -d
```

会自动：
- 起一个 MinIO 容器（API 9000，Console 9001）
- `minio-init` 一次性容器建好 `ivn-assets` bucket

## 控制台

<http://localhost:9001>

账号：`minio` / `minio12345`

可视化看上传的 object、删对象、改 policy。

## server 端配置

把下面这几行填进 `server/.env`：

```
S3_ENDPOINT=http://localhost:9000
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=minio
S3_SECRET_ACCESS_KEY=minio12345
S3_BUCKET=ivn-assets
S3_FORCE_PATH_STYLE=true
```

`.env.example` 里已有模板，复制过去改下即可。

## 数据位置

`ops/minio/data/` 被容器挂载作为 MinIO 数据目录。**已加进 `.gitignore`**，不会进仓库。

停 MinIO：`docker compose down`（保留数据）或 `docker compose down -v`（删容器 volume；目录文件仍在）。

## 切阿里云 OSS

生产环境把 `server/.env` 改成：

```
S3_ENDPOINT=https://oss-cn-<region>.aliyuncs.com     # 比如 oss-cn-hangzhou.aliyuncs.com
S3_REGION=oss-cn-<region>                             # 阿里云 region id
S3_ACCESS_KEY_ID=<AK>
S3_SECRET_ACCESS_KEY=<SK>
S3_BUCKET=<bucket name>
S3_FORCE_PATH_STYLE=true                              # 阿里云也支持 path-style
```

代码不改。

## 常见坑

1. **`S3_FORCE_PATH_STYLE` 在两家不同**：
   - **MinIO**：必须 `true`（走 `localhost:9000/bucket/key`），否则解析成 `bucket.localhost:9000` 连不上
   - **阿里云 OSS**：必须 `false`（走 `bucket.oss-cn-xxx.aliyuncs.com/key`）。实测 OSS 会直接返回
     `SecondLevelDomainForbidden: Please use virtual hosted style to access` 拒绝 path-style
2. **CORS**：本 MVP 不需要，因为前端通过 server 反代 (`GET /api/assets/*`) 拉对象，不是直接请求 OSS
3. **生产上 OSS bucket ACL**：默认 private 就行，我们走后端反代。给 AK 最小权限时 Resource 圈定到那一个 bucket，Action 给 `oss:GetObject` / `oss:PutObject` / `oss:DeleteObject`
4. **Metadata**：上传时会自动带上溯源 metadata（`app=ivn-engine` / `db=<database>` /
   `script-id=<sid>` / `asset-kind=<sprite|background>` / `uploaded-by=<user-id>`），
   OSS 控制台 object 详情 → "用户 meta" 里能看到
