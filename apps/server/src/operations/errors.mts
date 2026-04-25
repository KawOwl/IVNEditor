/**
 * Op 系统的类型化错误。
 *
 * 业务 op 的 exec() 抛 OpError，adapter（HTTP / MCP）按 code 翻译成各自
 * 协议的错误形态：
 *
 *   HTTP   : { ok: false, code, message, details? } + status mapping
 *   MCP    : { content: [{type:'text', text:'...'}], isError: true }
 *
 * exec 千万不要 throw new Error(...)，否则会被 adapter 当成 INTERNAL，丢
 * 掉细节。
 *
 * 也别在 service 层抛 OpError —— service 是更底层抽象，应当抛领域错误
 * （例如 ScriptNotFoundError）。op 的 exec 负责把领域错误映射成 OpError。
 */

/** Op 错误码（窄集合，避免 HTTP-like 错误码爆炸）*/
export type OpErrorCode =
  /** 入参 schema 校验失败（runOp 自动抛）*/
  | 'INVALID_INPUT'
  /** 调用方未认证 / 认证失败 */
  | 'UNAUTHORIZED'
  /** 已认证但权限不够（admin-only 但不是 admin 等）*/
  | 'FORBIDDEN'
  /** 引用的资源不存在（scriptId / versionId / segmentId 等查不到）*/
  | 'NOT_FOUND'
  /** 业务规则冲突（试图发布已 archived 的版本、删除被 playthrough 引用的 config 等）*/
  | 'CONFLICT'
  /** dry-run / 二阶段确认未通过（destructive op 缺 confirm）*/
  | 'CONFIRMATION_REQUIRED'
  /** 第三方服务挂了（LLM / S3 / DB）*/
  | 'UPSTREAM_UNAVAILABLE'
  /** 内部 bug（output schema 不匹配 / unreachable 分支等）*/
  | 'INTERNAL';

export interface OpErrorDetails {
  /** 触发错误的字段路径 / 原始 zod 错误 / 辅助上下文等 */
  readonly [key: string]: unknown;
}

export interface OpErrorOptions {
  cause?: unknown;
  details?: OpErrorDetails;
}

/**
 * 类型化错误。adapter 用 instanceof OpError 识别。
 */
export class OpError extends Error {
  readonly code: OpErrorCode;
  readonly details: OpErrorDetails;
  override readonly cause: unknown;

  constructor(code: OpErrorCode, message: string, options: OpErrorOptions = {}) {
    super(message);
    this.name = 'OpError';
    this.code = code;
    this.details = options.details ?? {};
    this.cause = options.cause;
  }
}

/**
 * HTTP status 映射。adapter 用，不强制——某些 op 可能想 override
 * （例：put-if-match 类用 412），通过把 details.httpStatus 显式塞进去。
 */
export function opErrorToHttpStatus(err: OpError): number {
  if (typeof err.details['httpStatus'] === 'number') {
    return err.details['httpStatus'] as number;
  }
  switch (err.code) {
    case 'INVALID_INPUT':
      return 400;
    case 'UNAUTHORIZED':
      return 401;
    case 'FORBIDDEN':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'CONFLICT':
      return 409;
    case 'CONFIRMATION_REQUIRED':
      return 428; // Precondition Required
    case 'UPSTREAM_UNAVAILABLE':
      return 502;
    case 'INTERNAL':
      return 500;
  }
}
