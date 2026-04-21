/**
 * AssetStorage — S3 协议抽象（M4）
 *
 * 统一接口，底层可插拔：
 *   - 本地 dev：MinIO（`S3_ENDPOINT=http://localhost:9000` + `S3_FORCE_PATH_STYLE=true`）
 *   - 生产：阿里云 OSS（S3 兼容端点 `https://oss-cn-<region>.aliyuncs.com`）
 *
 * 只依赖 S3 API，不用 OSS 专有特性。
 *
 * 关键实现注意：
 *   - put 走 `@aws-sdk/lib-storage` 的 `Upload`（自动分片 + 流式，不会把大文件
 *     buffer 进内存）
 *   - get 返回 Web ReadableStream，调用方可以直接 pipe 到 Elysia Response
 *   - 不做 mime 校验 / 大小校验（按 Q5：不限制）
 */

import {
  S3Client,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { Readable as NodeReadable } from 'node:stream';

// ============================================================================
// Types
// ============================================================================

export interface AssetGetResult {
  /** Web ReadableStream，可以直接塞进 `new Response(stream)` */
  stream: ReadableStream<Uint8Array>;
  contentType: string;
  contentLength?: number;
}

export interface AssetStorage {
  /** 上传一个 object；stream 可以是 Node Readable 或 Web ReadableStream */
  put(key: string, body: NodeReadable | ReadableStream, contentType?: string): Promise<void>;
  /** 读取 object。不存在返回 null（不抛） */
  get(key: string): Promise<AssetGetResult | null>;
  /** 删除 object；不存在静默忽略 */
  delete(key: string): Promise<void>;
  /** 只查 metadata（可选，用来校验存在性） */
  head(key: string): Promise<{ contentType?: string; contentLength?: number } | null>;
}

// ============================================================================
// S3 impl
// ============================================================================

export interface S3StorageConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** MinIO / 阿里云 OSS 多数场景需要 true；true 走 `<endpoint>/<bucket>/<key>`；
   *  false 走 vhost 风格 `<bucket>.<endpoint>/<key>` */
  forcePathStyle?: boolean;
}

export class S3AssetStorage implements AssetStorage {
  private client: S3Client;
  private bucket: string;

  constructor(config: S3StorageConfig) {
    const clientConfig: S3ClientConfig = {
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: config.forcePathStyle ?? true,
    };
    this.client = new S3Client(clientConfig);
    this.bucket = config.bucket;
  }

  async put(
    key: string,
    body: NodeReadable | ReadableStream,
    contentType?: string,
  ): Promise<void> {
    // lib-storage 的 Upload 自动分片 + 流式，大文件不会压垮内存
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: body as NodeReadable, // SDK 类型接受 Readable，运行时也接受 Web stream
        ContentType: contentType,
      },
    });
    await upload.done();
  }

  async get(key: string): Promise<AssetGetResult | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!res.Body) return null;
      // SDK v3 在 Node 里返回 Readable；用 transformToWebStream 转成 Web stream
      // 以便直接塞进 Response。
      const body = res.Body as unknown as {
        transformToWebStream(): ReadableStream<Uint8Array>;
      };
      return {
        stream: body.transformToWebStream(),
        contentType: res.ContentType ?? 'application/octet-stream',
        contentLength: res.ContentLength,
      };
    } catch (err: unknown) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (err) {
      if (isNotFound(err)) return;
      throw err;
    }
  }

  async head(key: string): Promise<{ contentType?: string; contentLength?: number } | null> {
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        contentType: res.ContentType,
        contentLength: res.ContentLength,
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }
}

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e.name === 'NoSuchKey' ||
    e.name === 'NotFound' ||
    e.$metadata?.httpStatusCode === 404
  );
}

// ============================================================================
// Env-driven singleton
// ============================================================================

let cachedStorage: AssetStorage | null = null;

/**
 * 从环境变量构造 storage。任一必填项缺失就抛错（server 启动时应该立刻失败）。
 *
 * 必填：S3_ENDPOINT / S3_REGION / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY / S3_BUCKET
 * 可选：S3_FORCE_PATH_STYLE（默认 true）
 */
export function getAssetStorage(): AssetStorage {
  if (cachedStorage) return cachedStorage;

  const endpoint = process.env.S3_ENDPOINT;
  const region = process.env.S3_REGION;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  const bucket = process.env.S3_BUCKET;
  const forcePathStyle = process.env.S3_FORCE_PATH_STYLE !== 'false';

  const missing: string[] = [];
  if (!endpoint) missing.push('S3_ENDPOINT');
  if (!region) missing.push('S3_REGION');
  if (!accessKeyId) missing.push('S3_ACCESS_KEY_ID');
  if (!secretAccessKey) missing.push('S3_SECRET_ACCESS_KEY');
  if (!bucket) missing.push('S3_BUCKET');

  if (missing.length > 0) {
    throw new Error(
      `[asset-storage] missing env vars: ${missing.join(', ')}\n` +
      `  本地开发请先跑 ops/minio/docker-compose.yml，然后 cp server/.env.example server/.env 填 S3_* 字段。`,
    );
  }

  cachedStorage = new S3AssetStorage({
    endpoint: endpoint!,
    region: region!,
    accessKeyId: accessKeyId!,
    secretAccessKey: secretAccessKey!,
    bucket: bucket!,
    forcePathStyle,
  });
  return cachedStorage;
}

/** 仅测试用：注入 mock storage 覆盖单例 */
export function __setAssetStorageForTesting(storage: AssetStorage | null): void {
  cachedStorage = storage;
}
