// 近似估算。中英混杂启发式：CJK 1 char ≈ 1 token，其他按 char/4。
// 不依赖外部 tokenizer 减重；caller 想精确可在 Section.tokens 里提供。
export const estimateTokens = (text: string): number => {
  if (text.length === 0) return 0;
  const cjkCount = (text.match(/[一-鿿]/g) ?? []).length;
  const otherCount = text.length - cjkCount;
  return Math.ceil(cjkCount + otherCount / 4);
};
