/**
 * RawStreamingStore — dev-only 最近一次 generate 的原始文本
 *
 * M1 Step 1.7：老的 NarrativeView 用 `entries[]` 保存完整流式文本，现在
 * VN 渲染走结构化 `parsedSentences`，原始 XML-lite 文本流就丢了。排查
 * 解析问题（比如 `<d>` 标签格式不对 / PF attrs parsing bug）时还是要看
 * 原文，所以单独挂一个"裸流"小仓库，EditorDebugPanel 的 "Raw Streaming"
 * tab 订阅它。
 *
 * 生命周期：每次 `begin-streaming`（WS 事件）清空 → 累加 text-chunk →
 *   `finalize` 时静默保留供查看 → 下一次 `begin-streaming` 清空。
 */

import { create } from 'zustand';

interface RawStreamingState {
  /** 最近一次 generate 的原始 XML-lite 文本（累加） */
  text: string;
  /** 最近一次 reasoning/think 的原始文本（累加） */
  reasoning: string;
  /** 收到一段 chunk */
  append: (chunk: string) => void;
  /** 收到一段 reasoning chunk */
  appendReasoning: (chunk: string) => void;
  /** 开始新的一次 generate，清空上一次的残留 */
  beginNew: () => void;
  /** 手动清空 */
  clear: () => void;
}

export const useRawStreamingStore = create<RawStreamingState>((set) => ({
  text: '',
  reasoning: '',
  append: (chunk) => set((s) => ({ text: s.text + chunk })),
  appendReasoning: (chunk) => set((s) => ({ reasoning: s.reasoning + chunk })),
  beginNew: () => set({ text: '', reasoning: '' }),
  clear: () => set({ text: '', reasoning: '' }),
}));
