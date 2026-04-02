/**
 * 生成 UUID v4
 *
 * 优先使用 crypto.randomUUID()（仅 Secure Context 可用），
 * 回退到 crypto.getRandomValues() 手动拼接（所有现代浏览器可用）。
 */
export function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // fallback: 用 getRandomValues 拼 UUID v4
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // 设置 version (4) 和 variant (10xx)
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
