/**
 * Auth — 简单的管理员认证模块
 *
 * 3 个硬编码管理员用户，基于 HMAC-SHA256 token 认证。
 * token 格式：`username:timestamp:signature`
 * 有效期 7 天。
 */

// ============================================================================
// Admin Users（硬编码）
// ============================================================================

interface AdminUser {
  username: string;
  password: string;
  displayName: string;
}

const ADMIN_USERS: AdminUser[] = [
  { username: 'admin', password: 'ivn@2024', displayName: '管理员' },
  { username: 'kawowl', password: 'kawowl@ivn', displayName: 'KawOwl' },
  { username: 'editor', password: 'editor@ivn', displayName: '编剧' },
];

// Token 签名密钥（生产环境应使用环境变量）
const TOKEN_SECRET = process.env.AUTH_SECRET ?? 'ivn-auth-secret-2024';
const TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ============================================================================
// Token 生成 / 验证
// ============================================================================

async function hmacSign(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(TOKEN_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 生成认证 token */
export async function generateToken(username: string): Promise<string> {
  const timestamp = Date.now().toString();
  const payload = `${username}:${timestamp}`;
  const signature = await hmacSign(payload);
  return `${payload}:${signature}`;
}

/** 验证 token，返回用户名或 null */
export async function verifyToken(token: string): Promise<string | null> {
  const parts = token.split(':');
  if (parts.length !== 3) return null;

  const [username, timestampStr, signature] = parts;
  if (!username || !timestampStr || !signature) return null;

  // 检查过期
  const timestamp = parseInt(timestampStr, 10);
  if (isNaN(timestamp) || Date.now() - timestamp > TOKEN_EXPIRY_MS) return null;

  // 检查签名
  const payload = `${username}:${timestampStr}`;
  const expectedSig = await hmacSign(payload);
  if (signature !== expectedSig) return null;

  // 检查用户是否存在
  if (!ADMIN_USERS.some((u) => u.username === username)) return null;

  return username;
}

// ============================================================================
// Login
// ============================================================================

/** 验证用户名密码，返回 { token, user } 或 null */
export async function login(
  username: string,
  password: string,
): Promise<{ token: string; username: string; displayName: string } | null> {
  const user = ADMIN_USERS.find(
    (u) => u.username === username && u.password === password,
  );
  if (!user) return null;

  const token = await generateToken(user.username);
  return { token, username: user.username, displayName: user.displayName };
}

// ============================================================================
// Middleware helper
// ============================================================================

/** 从请求中提取并验证 token，返回用户名或 null */
export async function extractAdmin(request: Request): Promise<string | null> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  return verifyToken(token);
}
