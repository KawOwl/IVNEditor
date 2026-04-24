/**
 * Typewriter speed persistence helper (localStorage)
 *
 * 从老 NarrativeView.tsx 挪过来的（M1 Step 1.7 NarrativeView 下线），
 * 现在被 VNStageContainer 的 useDialogTypewriter 和 PlayPage 设置 popover、
 * LLMSettingsPanel 使用。
 */

const LS_TYPEWRITER_KEY = 'ivn-typewriter-speed';

/** 每秒最大字符数。0 = 无限速（即时显示） */
export function getTypewriterSpeed(): number {
  if (typeof window === 'undefined') return 0;
  const raw = localStorage.getItem(LS_TYPEWRITER_KEY);
  if (raw) {
    const n = Number(raw);
    if (!isNaN(n) && n >= 0) return n;
  }
  // 默认即时全显。打字机虽然有仪式感，但：
  //   1. 长叙事（500–1500 字）走完要 10–25s，玩家阅读远快于此，逐字等很烦
  //   2. LLM 流式到达本身已经是"渐显"体验，再套一层打字机冗余
  //   3. 想要的用户能从设置 popover 里切回 20/60/150 cps
  return 0;
}

export function setTypewriterSpeed(cps: number): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(LS_TYPEWRITER_KEY, String(Math.max(0, Math.round(cps))));
}
