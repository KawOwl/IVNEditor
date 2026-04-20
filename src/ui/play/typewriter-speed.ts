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
  if (typeof window === 'undefined') return 60;
  const raw = localStorage.getItem(LS_TYPEWRITER_KEY);
  if (raw) {
    const n = Number(raw);
    if (!isNaN(n) && n >= 0) return n;
  }
  return 60;
}

export function setTypewriterSpeed(cps: number): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(LS_TYPEWRITER_KEY, String(Math.max(0, Math.round(cps))));
}
