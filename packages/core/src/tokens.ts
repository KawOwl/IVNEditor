/**
 * Token 估算工具 —— 从 memory.ts 剥出来的纯函数
 *
 * 之所以独立成一个文件：被 core、architect、ui、fixtures 多处消费，
 * 和 memory 的内部状态其实没有依赖关系。挂在 memory.ts 下会让
 * UI / fixtures 只为了拿一个估算函数而 import 整个 memory 模块。
 */

/** 粗略估算：按混合 CJK + 英文约 4 chars/token 算。 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
