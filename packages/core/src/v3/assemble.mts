import { estimateTokens } from '#internal/v3/tokens';

// ──────────────────────────────────────────────────────────
// Types — caller-side context 拼装抽象
// 不在 kernel 内：kernel 只接 `system: string`，不知道 Section / Budget 概念。
// 这是 caller-side helper（同 consume / retry），由 caller 选用。
// ──────────────────────────────────────────────────────────

export type Section = {
  readonly id: string;
  readonly content: string;
  readonly priority: number;
  readonly tag?: string;
  readonly tokens?: number;
  readonly trimmable?: boolean;
};

export type AssembleInput = {
  readonly systemSections: readonly Section[];
  readonly contextSections: readonly Section[];
  readonly budgetTokens: number;
};

export type DroppedSection = {
  readonly id: string;
  readonly reason: 'budget';
  readonly tokens: number;
};

export type AssembledPrompt = {
  readonly systemPrompt: string;
  readonly droppedSections: readonly DroppedSection[];
  readonly breakdown: Readonly<Record<string, number>>;
  readonly totalTokens: number;
};

// ──────────────────────────────────────────────────────────
// packSections — 纯函数
// systemSections 永 included；contextSections 按 priority 升序 pack 至 budget。
// trimmable=true 的 section 在超 budget 时被丢；non-trimmable（缺省 / 显式
// false）即使超 budget 仍强留。
// ──────────────────────────────────────────────────────────

const tokensOf = (s: Section): number =>
  s.tokens ?? estimateTokens(s.content);

const tagOf = (s: Section, fallback: string): string => s.tag ?? fallback;

export const packSections = (input: AssembleInput): AssembledPrompt => {
  const systemTokens = input.systemSections.reduce(
    (sum, s) => sum + tokensOf(s),
    0,
  );

  const sortedCtx = [...input.contextSections].sort(
    (a, b) => a.priority - b.priority,
  );
  const remaining = Math.max(0, input.budgetTokens - systemTokens);

  const accepted: Section[] = [];
  const dropped: DroppedSection[] = [];
  let ctxTokens = 0;

  for (const s of sortedCtx) {
    const t = tokensOf(s);
    const fits = ctxTokens + t <= remaining;
    if (fits || s.trimmable !== true) {
      accepted.push(s);
      ctxTokens += t;
    } else {
      dropped.push({ id: s.id, reason: 'budget', tokens: t });
    }
  }

  const systemPrompt = [
    ...input.systemSections.map((s) => s.content),
    ...accepted.map((s) => s.content),
  ].join('\n\n');

  const breakdown: Record<string, number> = {};
  for (const s of input.systemSections) {
    const k = tagOf(s, '_system');
    breakdown[k] = (breakdown[k] ?? 0) + tokensOf(s);
  }
  for (const s of accepted) {
    const k = tagOf(s, '_untagged');
    breakdown[k] = (breakdown[k] ?? 0) + tokensOf(s);
  }

  return {
    systemPrompt,
    droppedSections: dropped,
    breakdown,
    totalTokens: systemTokens + ctxTokens,
  };
};
