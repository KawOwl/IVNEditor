import { z } from 'zod/v4';
import { parse as parseDotenv } from 'dotenv';

export type DotenvSource = Record<string, string | undefined>;

export interface AdminUserEnv {
  username: string;
  password: string;
}

const emptyToUndefined = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

const optionalEnvString = z.preprocess(emptyToUndefined, z.string().optional());

const requiredEnvString = (name: string) =>
  z.preprocess(emptyToUndefined, z.string().min(1, `${name} is required`));

function integerFromEnv(
  _name: string,
  defaultValue: number,
  opts: { min?: number; max?: number } = {},
) {
  return z.preprocess((value) => {
    const normalized = emptyToUndefined(value);
    if (normalized === undefined) return defaultValue;
    if (typeof normalized === 'number') return normalized;
    if (typeof normalized === 'string') {
      const parsed = Number(normalized);
      return Number.isNaN(parsed) ? normalized : parsed;
    }
    return normalized;
  }, z.number().int().min(opts.min ?? 1).max(opts.max ?? Number.MAX_SAFE_INTEGER));
}

function booleanFromEnv(_name: string, defaultValue: boolean) {
  return z.preprocess((value) => {
    const normalized = emptyToUndefined(value);
    if (normalized === undefined) return defaultValue;
    if (typeof normalized === 'boolean') return normalized;
    if (typeof normalized !== 'string') return normalized;

    switch (normalized.toLowerCase()) {
      case '1':
      case 'true':
      case 'yes':
      case 'on':
        return true;
      case '0':
      case 'false':
      case 'no':
      case 'off':
        return false;
      default:
        return normalized;
    }
  }, z.boolean());
}

const urlString = (name: string) =>
  requiredEnvString(name).refine((value) => {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  }, `${name} must be a valid URL`);

const optionalUrlString = (name: string) =>
  optionalEnvString.refine((value) => {
    if (value === undefined) return true;
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  }, `${name} must be a valid URL`);

const pgSslSchema = z.preprocess((value) => {
  const normalized = emptyToUndefined(value);
  return typeof normalized === 'string' ? normalized.toLowerCase() : normalized;
}, z.enum(['off', 'false', 'disable', 'require', 'prefer', 'verify', 'verify-ca', 'verify-full']).optional());

/**
 * `LLM_THINKING_ENABLED` —— DeepSeek V4 thinking 模式开关。三态：
 *   未设 / 空串 → undefined（seed 写 null：不覆盖模型默认）
 *   true/yes/on/1   → true（seed 写 true：transformRequestBody 注入 thinking:{type:'enabled'}）
 *   false/no/off/0  → false（seed 写 false：注入 thinking:{type:'disabled'}）
 *
 * 不复用 booleanFromEnv：那个 helper 必须给 default，强制返回 boolean；
 * 这里需要"未设"和"显式 false"两种状态可区分，前者代表"不写 DB 字段"。
 */
const optionalThinkingBoolean = z.preprocess((value) => {
  const normalized = emptyToUndefined(value);
  if (normalized === undefined) return undefined;
  if (typeof normalized === 'boolean') return normalized;
  if (typeof normalized !== 'string') return normalized;
  switch (normalized.toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true;
    case '0':
    case 'false':
    case 'no':
    case 'off':
      return false;
    default:
      return normalized;
  }
}, z.boolean().optional());

const optionalReasoningEffort = z.preprocess((value) => {
  const normalized = emptyToUndefined(value);
  return typeof normalized === 'string' ? normalized.toLowerCase() : normalized;
}, z.enum(['high', 'max']).optional());

function parseAdminUsers(raw: string | undefined): AdminUserEnv[] {
  if (!raw) return [];
  return raw
    .split(';')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const separator = pair.indexOf(':');
      if (separator < 0) {
        throw new Error(`missing ":" in "${pair}"`);
      }
      const username = pair.slice(0, separator).trim();
      const password = pair.slice(separator + 1).trim();
      if (!username || !password) {
        throw new Error(`empty username or password in "${pair}"`);
      }
      return { username, password };
    });
}

const adminUsersSchema = optionalEnvString.transform((raw, ctx) => {
  try {
    return parseAdminUsers(raw);
  } catch (error) {
    ctx.addIssue({
      code: 'custom',
      message: `ADMIN_USERS must be "username:password" pairs separated by semicolons (${error instanceof Error ? error.message : String(error)})`,
    });
    return [];
  }
});

export const ServerEnvSchema = z.object({
  NODE_ENV: z.preprocess(
    (value) => emptyToUndefined(value) ?? 'development',
    z.enum(['development', 'test', 'production']),
  ),
  PORT: integerFromEnv('PORT', 3001, { min: 1, max: 65535 }),

  DATABASE_URL: urlString('DATABASE_URL'),
  PG_SSL: pgSslSchema,
  PG_POOL_MAX: integerFromEnv('PG_POOL_MAX', 30, { min: 1 }),
  PG_CONNECT_TIMEOUT_MS: integerFromEnv('PG_CONNECT_TIMEOUT_MS', 15000, { min: 1 }),

  LLM_PROVIDER: z.preprocess(emptyToUndefined, z.string().min(1).default('openai-compatible')),
  LLM_BASE_URL: z.preprocess(emptyToUndefined, z.string().url().default('https://api.deepseek.com/v1')),
  LLM_API_KEY: optionalEnvString,
  LLM_MODEL: z.preprocess(emptyToUndefined, z.string().min(1).default('deepseek-chat')),
  LLM_NAME: z.preprocess(emptyToUndefined, z.string().min(1).default('default')),
  LLM_THINKING_ENABLED: optionalThinkingBoolean,
  LLM_REASONING_EFFORT: optionalReasoningEffort,

  MEM0_API_KEY: optionalEnvString,

  // Memorax (self-hosted long-term memory; runs in parallel with mem0).
  // 三个一组：base url / key / app id。缺任一 provider:'memorax' / 'parallel' 时 factory 抛错。
  MEMORAX_BASE_URL: optionalUrlString('MEMORAX_BASE_URL'),
  MEMORAX_API_KEY: optionalEnvString,
  MEMORAX_APP_ID: optionalEnvString,

  LANGFUSE_HOST: optionalUrlString('LANGFUSE_HOST'),
  LANGFUSE_PUBLIC_KEY: optionalEnvString,
  LANGFUSE_SECRET_KEY: optionalEnvString,

  S3_ENDPOINT: optionalEnvString,
  S3_REGION: optionalEnvString,
  S3_ACCESS_KEY_ID: optionalEnvString,
  S3_SECRET_ACCESS_KEY: optionalEnvString,
  S3_BUCKET: optionalEnvString,
  S3_FORCE_PATH_STYLE: booleanFromEnv('S3_FORCE_PATH_STYLE', true),

  /**
   * 服务启动时是否跑 drizzle migrator。
   *
   * 默认 true（部署到 k8s pod 时不设这个 env，沿用现状）。
   * 本地 dev 起 server 时建议设 false —— 避免本地 ivn_dev/ivn_test 在
   * baseline reset 之后被 migrator 撞 already-exists 拒绝启动。本地想
   * 同步 schema 走 `drizzle-kit push --force` / 一次性 SQL 脚本。
   */
  RUN_MIGRATIONS_ON_START: booleanFromEnv('RUN_MIGRATIONS_ON_START', true),

  ADMIN_USERS: adminUsersSchema,
});

export type ServerEnv = z.infer<typeof ServerEnvSchema>;

export const ServerAssetStorageEnvSchema = z.object({
  S3_ENDPOINT: requiredEnvString('S3_ENDPOINT'),
  S3_REGION: requiredEnvString('S3_REGION'),
  S3_ACCESS_KEY_ID: requiredEnvString('S3_ACCESS_KEY_ID'),
  S3_SECRET_ACCESS_KEY: requiredEnvString('S3_SECRET_ACCESS_KEY'),
  S3_BUCKET: requiredEnvString('S3_BUCKET'),
  S3_FORCE_PATH_STYLE: z.boolean(),
});

export type ServerAssetStorageEnv = z.infer<typeof ServerAssetStorageEnvSchema>;

export interface LlmConfigSeedEnv {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  name: string;
  /**
   * DeepSeek V4 thinking 开关。null = 不写 DB 字段（沿用模型默认）。
   * `LLMClient.getModel()` 仅当此字段非 null 时才把 thinking:{type:...} 注入 body。
   */
  thinkingEnabled: boolean | null;
  /** reasoning_effort 强度。null = 不传。仅 thinking 模式生效。 */
  reasoningEffort: 'high' | 'max' | null;
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

export function createServerEnv(source: DotenvSource): ServerEnv {
  const result = ServerEnvSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`[env] invalid server env: ${formatZodError(result.error)}`);
  }
  return result.data;
}

export function parseDotenvText(text: string): DotenvSource {
  return parseDotenv(text);
}

export function createServerAssetStorageEnv(env: ServerEnv): ServerAssetStorageEnv {
  const result = ServerAssetStorageEnvSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`[asset-storage] invalid S3 env: ${formatZodError(result.error)}`);
  }
  return result.data;
}

export function createLlmConfigSeedFromEnv(env: ServerEnv): LlmConfigSeedEnv | null {
  if (!env.LLM_API_KEY) return null;
  return {
    provider: env.LLM_PROVIDER,
    baseUrl: env.LLM_BASE_URL,
    apiKey: env.LLM_API_KEY,
    model: env.LLM_MODEL,
    name: env.LLM_NAME,
    thinkingEnabled: env.LLM_THINKING_ENABLED ?? null,
    reasoningEffort: env.LLM_REASONING_EFFORT ?? null,
  };
}
