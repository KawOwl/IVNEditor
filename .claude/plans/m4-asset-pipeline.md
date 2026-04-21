# M4：OSS 资产 pipeline（图片上传 + 渲染）

## Context

M1 玩家侧 VN 渲染和 M2 编辑器侧资产管理都已上线，但 `SpriteAsset.assetUrl` /
`BackgroundAsset.assetUrl` 一律留空，M1 渲染的是文字占位（`[background: 咖啡馆内景]`、
`咲夜·微笑` 卡片）。M4 补齐"真图"链路：编剧在 M2 编辑器能上传图片 → 后端走 S3 协议
存到对象存储 → M1 玩家流渲染真立绘 / 真背景。

## 锁定决策

| Q | 决策 |
|---|---|
| Q1 存储 | S3 协议：AWS SDK v3（`@aws-sdk/client-s3`），本地 dev MinIO，生产阿里云 OSS。切换只换 endpoint / credentials |
| Q2 URL 形态 | 相对 `/api/assets/:key`，后端反代 S3。manifest 里存 logical key 不存绝对 URL |
| Q3 所有权 | 资产跟 script 走（`script_assets` 表 FK `scripts.id`），删剧本级联删资产 |
| Q4 上传流程 | 前端 multipart POST `/api/scripts/:id/assets` → 后端存 + 返回 key |
| Q5 限制 | **不限制**。任意 mime、任意大小；流式上传避免内存堆积；后续发现问题再加 guardrail |
| 范围外 | 图片压缩 / 缩略图 / WebP 转换 / CDN 预热 / 多版本资产引用计数 / 资产库跨剧本复用 |

## 技术选型

- `@aws-sdk/client-s3` + `@aws-sdk/lib-storage`（后者的 `Upload` class 自动分片 + 流式，不会把大文件 buffer 进内存）
- 本地 dev：MinIO docker-compose（ops/minio/）
- 生产：阿里云 OSS S3 兼容端点（`https://oss-cn-<region>.aliyuncs.com`）

## 数据库 schema

新表 `script_assets`：

```sql
CREATE TABLE "script_assets" (
  "id" text PRIMARY KEY NOT NULL,                      -- uuid
  "script_id" text NOT NULL REFERENCES "scripts"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,                                -- 'background' | 'sprite'
  "storage_key" text NOT NULL UNIQUE,                  -- S3 key，形如 "scripts/<sid>/<uuid>.png"
  "original_name" text,                                -- 上传时的原文件名（诊断用）
  "content_type" text,                                 -- MIME，由 upload 时 header 决定
  "size_bytes" bigint,                                 -- 便于诊断/审计
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "idx_script_assets_script" ON "script_assets" ("script_id");
```

**决策**：manifest 里存**相对 URL 字符串** `/api/assets/<storage_key>`（直接可用于 `<img src>`），不存 logical id 查表。
  - 好处：manifest 自包含；前端渲染时 `<img src={spriteAsset.assetUrl}>` 就能用；无需额外 resolve 步骤
  - 坏处：rename storage key 会破坏老 manifest（但 storage_key 是 uuid-based，几乎不重命名）

## API 设计

```
POST   /api/scripts/:id/assets        — 上传一个资产（admin only，验 ownership）
                                        multipart/form-data:
                                          file     = <binary>
                                          kind     = 'background' | 'sprite'
                                        return: { id, storageKey, assetUrl }
DELETE /api/assets/:storageKey        — 删除资产（admin only，验 script ownership）
GET    /api/assets/:storageKey        — 读取（所有已认证身份）
                                        后端流式代理 S3 → client
                                        MVP 不做 pre-signed redirect（后续优化）
GET    /api/scripts/:id/assets        — 列出某剧本的所有资产（admin only，诊断用）
```

**MVP 路径**：GET 全部走服务端代理（不用 pre-signed URL）。简单、统一、不需要 OSS CORS 配置。性能优化留给后续。

## 前端改动

### CharactersSection / SpritesEditor
- 每个 sprite 行加一个"上传图片"按钮
- 点击弹 `<input type="file">`
- 选中后：
  1. POST `/api/scripts/:id/assets` (kind='sprite')
  2. 拿回 assetUrl
  3. 更新对应 sprite 的 `assetUrl` 字段（调用 `onChange`）
- 行旁边显示 thumbnail（32×32 或 48×48 圆角）
- 删除图片按钮：清空 `assetUrl`（但不删 S3 对象，留 orphan；后续 cleanup job 处理）

### BackgroundsSection
- 类似 CharactersSection
- 每行加"上传图片"按钮 + thumbnail

### DefaultSceneSection
- 背景下拉旁边显示选中背景的大缩略图（160×90）
- 如果有开场立绘，显示立绘的小缩略图叠加

### M1 渲染（SceneBackground / SpriteLayer）
- 已经在实现里支持 assetUrl，现在会真的收到 URL
- `<img src={assetUrl}>` 之前是判空走占位；有 URL 时直接用
- 占位兜底保留（URL 未设 / 加载失败）

## Steps

### Step 4.1 — backend: script_assets migration + AssetStorage 接口

**新增 migration `server/drizzle/0008_script_assets.sql`**
```sql
-- 建 script_assets 表（定义见 plan）
```

**改 `server/src/db/schema.ts`** — 加 `scriptAssets` 表定义

**新增 `server/src/services/asset-storage.ts`**
```ts
export interface AssetStorage {
  put(key: string, stream: ReadableStream, contentType: string): Promise<void>;
  get(key: string): Promise<{ stream: ReadableStream; contentType: string; size?: number } | null>;
  delete(key: string): Promise<void>;
}

export class S3AssetStorage implements AssetStorage { /* 用 @aws-sdk/client-s3 */ }
```

构造参数：endpoint / region / accessKeyId / secretAccessKey / bucket / forcePathStyle（MinIO 需要）。

**新增 `server/src/services/asset-service.ts`** — 数据库 CRUD（create / getById / getByKey / listByScript / deleteByScript / delete）。

**验收**：
- bun tsc 通过
- 新增单元测试（mock storage）验证 save → getByKey 往返

### Step 4.2 — backend: 上传/下载/删除 routes

**新增 `server/src/routes/assets.ts`**
- POST `/api/scripts/:id/assets` — multipart 解析；验 script.author_user_id === admin；流式 put 到 S3；insert `script_assets` 行；返回 `{ id, storageKey, assetUrl }`
- GET `/api/assets/:storageKey` — 任何已认证身份；verify storage_key 存在；调 storage.get → pipe 流到响应；设置 Content-Type header
- DELETE `/api/assets/:storageKey` — admin only + verify ownership（查 script_assets.script_id → scripts.author_user_id 校验）；storage.delete + DB delete

**ownership 校验辅助**：`verifyScriptOwnership(scriptId, userId)` helper。

**接线**：`server/src/app-setup.ts` 注册 `assetRoutes`。

**storage_key 生成**：`scripts/${scriptId}/${uuid}${extFromMime(contentType)}`

**验收**：
- curl 上传一张 PNG → 成功返回 `{ assetUrl }`
- 访问 `/api/assets/<key>` 能看到图
- DELETE 后再访问返回 404

### Step 4.3 — 本地 dev MinIO 设置

**新增 `ops/minio/docker-compose.yml`**
```yaml
services:
  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    ports: ["9000:9000", "9001:9001"]
    environment:
      MINIO_ROOT_USER: minio
      MINIO_ROOT_PASSWORD: minio12345
    volumes:
      - ./data:/data
```

**新增 `ops/minio/README.md`** — 启动 + 建 bucket 指引。

**改 `server/.env.example`** — 加 S3 配置块：
```
# S3-compatible storage (MinIO local / Aliyun OSS prod)
S3_ENDPOINT=http://localhost:9000
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=minio
S3_SECRET_ACCESS_KEY=minio12345
S3_BUCKET=ivn-assets
S3_FORCE_PATH_STYLE=true    # MinIO 需要；阿里云 OSS 也支持
```

**验收**：docker-compose up 后 MinIO console `http://localhost:9001` 能开，建 bucket `ivn-assets`。Server 启动能连。

### Step 4.4 — frontend: CharactersSection / BackgroundsSection 上传按钮

**改 `src/ui/editor/ScriptInfoPanel.tsx`**
- 新 helper hook `useAssetUpload(scriptId, kind)` 返回 `{ upload(file): Promise<assetUrl>, uploading: boolean }`
- 每个 sprite 行：
  - 左侧 id / label 输入
  - 右侧：已有 assetUrl → `<img class="w-10 h-10 object-cover rounded">` + "换"按钮；无 → "上传"按钮
  - 上传按钮触发 `<input type="file" hidden>` → onChange 调 useAssetUpload
- 同样改背景行

**Edge case**：当 `scriptId` 为 null（新剧本没保存过），上传按钮灰掉，提示"先保存剧本"。

**验收**：
- 新建剧本 → 保存 → 加角色 sakuya + sprite smile → 点上传 → 选一张 smile.png → 行里出现缩略图
- 刷新编辑器 → 再 load 剧本 → 缩略图还在
- 换图：点"换"再选另一张 → 缩略图更新
- 删除图：按钮暂不做（`assetUrl = undefined` 通过"清除"按钮或者直接删整 sprite 行）

### Step 4.5 — frontend: DefaultSceneSection 预览

**改 `src/ui/editor/ScriptInfoPanel.tsx` DefaultSceneSection**
- 选中的背景下拉下方显示背景大缩略图（`w-40 h-24`）
- 有开场立绘时，缩略图上叠加立绘小图（根据 position 靠左/中/右）

**验收**：在 default scene 选 cafe_interior + 开场立绘 sakuya:smile@center → 看到咖啡馆背景 + sakuya 立绘小图叠加

### Step 4.6 — M1 SceneBackground / SpriteLayer 渲染真图

**改 `src/ui/play/vn/SceneBackground.tsx`**
- 已经支持 assetUrl；现在多加一个 `onError` 兜底（加载失败时回落到占位）

**改 `src/ui/play/vn/SpriteLayer.tsx`**
- 同上，`<img onError={...}>` fallback 到占位卡片

**验收**：玩咖啡馆剧本 → 看到真的咖啡馆背景（上传过的）+ 真的 sakuya 立绘

### Step 4.7 — 验证 + commit 拆分

**类型检查 + 测试**
- `bun tsc --noEmit` clean
- `cd server && bun test` 95/95

**Preview E2E**
1. 启动 MinIO + server + dev
2. 登录 admin → 新建剧本（或用 m3-cafe-test）
3. 编辑器加角色 + 上传 1 个 sprite
4. 加背景 + 上传 1 张背景图
5. default scene 选择 + 看到预览
6. 保存 → 发布
7. 回首页 → 玩 → 看到真图（立绘 + 背景）
8. 关 MinIO → 刷新 → 图加载失败 → 看到占位兜底

**Commit 拆分**
- `feat(m4a): 后端资产存储 — S3 抽象 + script_assets 表 + 上传/下载 routes`（Step 4.1-4.3）
- `feat(m4b): 前端资产上传 UI + 缩略图预览`（Step 4.4-4.5）
- `feat(m4c): M1 渲染真立绘真背景 + 加载失败兜底`（Step 4.6）
- 可选 `docs(m4)`：PROGRESS + feature_list + plan 标记 done

## 遗留到后续 milestone

- **缩略图自动生成**：当前每个 thumbnail 都加载原图，列表多了会慢
- **WebP 自动转换**：节省带宽
- **pre-signed URL + CDN**：大规模场景下 `/api/assets/:key` 代理会瓶颈
- **资产库跨剧本复用**：ownership 改成 user 级，加"我的立绘库"UI
- **Orphan 清理 job**：assetUrl 清空后 S3 对象没有被删除
- **批量上传**：一次传一组立绘（比如 drag-and-drop 多个文件）
- **图片裁剪 / 切边工具**：编辑器内处理透明通道等
