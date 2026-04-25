/**
 * OpContext —— op exec 拿到的"运行时上下文"。
 *
 * 刻意做成框架无关的窄形状（不暴露 Request / Identity / Elysia.Context），
 * 这样 op 业务代码不会触到任何 adapter 层细节。adapter 在调用前要把自己
 * 框架原生的身份对象转成 OpContext。
 *
 * 防腐契约 #2 的兑现物。
 */

/**
 * 复用 auth-identity 里的 IdentityKind。
 *  - 'anonymous'  — 匿名玩家（自动建的 sessionId，没注册）
 *  - 'registered' — 注册用户但不是 admin
 *  - 'admin'      — 管理员
 *  - null         — 未认证（auth: 'none' 时才会出现）
 */
export type OpIdentityKind = 'anonymous' | 'registered' | 'admin';

export interface OpContext {
  /** 用户 id（users.id UUID）。auth='none' 时可能为 null */
  readonly userId: string | null;
  /** 身份种类。auth='none' 时为 null */
  readonly kind: OpIdentityKind | null;
  /** 用户名，anonymous 没有 */
  readonly username: string | null;
  /** 显示名 */
  readonly displayName: string | null;
  /** 调用追踪 id（adapter 生成或透传），方便日志关联 */
  readonly requestId: string;
  /** 来源：标识哪个 adapter 触发的 op，便于 audit */
  readonly source: 'http' | 'mcp' | 'internal';
}

/** 给 adapter 用：从 auth-identity 的 Identity 转 OpContext */
export interface IdentityShape {
  readonly kind: OpIdentityKind;
  readonly userId: string;
  readonly username: string | null;
  readonly displayName: string | null;
}

export function identityToOpContext(
  identity: IdentityShape,
  source: OpContext['source'],
  requestId: string,
): OpContext {
  return {
    userId: identity.userId,
    kind: identity.kind,
    username: identity.username,
    displayName: identity.displayName,
    requestId,
    source,
  };
}

/** 未认证场景（auth='none' 的 op）使用的占位 ctx */
export function anonymousOpContext(source: OpContext['source'], requestId: string): OpContext {
  return {
    userId: null,
    kind: null,
    username: null,
    displayName: null,
    requestId,
    source,
  };
}
