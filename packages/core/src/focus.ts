/**
 * Focus Injection —— 把"当前场景/人物/阶段"作为 prompt 组装和记忆检索的信号
 *
 * 设计见 .claude/plans/focus-injection.md。
 *
 * MVP 只消费 scene 一维：
 *   - computeFocus 从 stateVars 读 current_scene
 *   - scoreSegment 按 segment.focusTags.scene 匹配打分
 *   - rankSegments 返回分数最高的 top N
 *
 * 这些函数都是**无副作用的纯函数**，不调 LLM、不读 memory —— 只做 state ↔
 * segment 的本地 join。所以调用成本接近零，context-assembler 每轮 generate
 * 调一次完全可接受。
 *
 * v2 扩展点：
 *   - computeFocus 读 active_characters / current_phase
 *   - scoreSegment 加 chars / stage 维度权重
 *   - 未来 B2 升级时 rankSegments 返回的结果变成"过滤注入白名单"
 */

import type { PromptSegment, FocusState } from './types';

/**
 * 从 state_vars 推断当前 focus。
 *
 * 剧本 state schema 需要约定字段名（当前硬编码 `current_scene`；v2 可以改为
 * 剧本级配置 `memoryConfig.focusFieldMapping = { scene: 'current_scene' }`）。
 *
 * 剧本 state 里没有这些字段时，相应的 focus 维度返回 undefined ——
 * context-assembler 和 rankSegments 对 undefined 都能 degrade 成 no-op，不崩。
 */
export function computeFocus(stateVars: Record<string, unknown>): FocusState {
  return {
    scene: typeof stateVars.current_scene === 'string'
      ? stateVars.current_scene
      : undefined,
    // v2: characters, stage
  };
}

/**
 * segment 对当前 focus 的匹配分数。
 *
 * MVP 评分规则：
 *   - segment 无 focusTags → 0（不参与排序，但原全量注入逻辑还会把它加进 prompt）
 *   - scene 维度命中 → +3
 *   - 其他维度 MVP 不算
 *
 * 分数 0 的 segment 不会出现在 _engine_scene_context section 的 top list 里，
 * 但**仍然全量注入到 system prompt 主体**（B1 模式，未来 B2 才会按分数过滤）。
 */
export function scoreSegment(seg: PromptSegment, focus: FocusState): number {
  if (!seg.focusTags) return 0;
  let score = 0;
  if (seg.focusTags.scene && focus.scene === seg.focusTags.scene) {
    score += 3;
  }
  // v2: chars / stage 维度
  return score;
}

/**
 * 对一组 segments 按 focus 打分、降序排列、取 top N。
 * 仅返回 score > 0 的 segment（无标签或不匹配的不出现）。
 */
export function rankSegments(
  segments: PromptSegment[],
  focus: FocusState,
  topN = 5,
): PromptSegment[] {
  return segments
    .map((seg) => ({ seg, score: scoreSegment(seg, focus) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map((x) => x.seg);
}
