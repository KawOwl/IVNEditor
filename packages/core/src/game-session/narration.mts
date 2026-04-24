/**
 * 旁白 Sentence 切分策略
 *
 * VN UI 对一条 Sentence 一屏打字机的粒度敏感：
 *   - 太大：玩家读一段要等很久、也不好 backlog 翻页
 *   - 太小：点击推进变得碎
 */

export const NARRATION_SOFT_LIMIT = 400;
export const NARRATION_HARD_LIMIT = 800;

/**
 * 一段连续旁白里下一个切分点。
 *
 * 切分优先级（从高到低）：
 *   1. `\n\n` —— 作者 / 模型自然的段落边界
 *   2. 超过 MAX 软阈值 + 找到句末标点（。！？.!?）—— 长段落按句分
 *   3. 超过 HARD 硬上限 + 找到任意收束字符（。！？.!? ， ；\n 空格）—— 兜底
 *   4. 没找到合适切点 → 返回 null，留给后续 chunk / finalize
 */
export function findNarrationCut(buf: string): { end: number; consume: number } | null {
  const paraIdx = buf.indexOf('\n\n');
  if (paraIdx >= 0) {
    return { end: paraIdx, consume: paraIdx + 2 };
  }

  if (buf.length > NARRATION_SOFT_LIMIT) {
    const searchFrom = Math.floor(NARRATION_SOFT_LIMIT * 0.7);
    const sentIdx = findSentenceEnd(buf, searchFrom);
    if (sentIdx >= 0) {
      return { end: sentIdx + 1, consume: sentIdx + 1 };
    }
  }

  if (buf.length > NARRATION_HARD_LIMIT) {
    const weakIdx = findWeakBreak(buf, Math.floor(NARRATION_HARD_LIMIT * 0.7));
    if (weakIdx >= 0) {
      return { end: weakIdx + 1, consume: weakIdx + 1 };
    }
    return { end: NARRATION_HARD_LIMIT, consume: NARRATION_HARD_LIMIT };
  }

  return null;
}

function findSentenceEnd(buf: string, from: number): number {
  for (let i = from; i < buf.length; i++) {
    const ch = buf[i];
    if (ch === '。' || ch === '！' || ch === '？' || ch === '.' || ch === '!' || ch === '?') {
      return i;
    }
  }
  return -1;
}

function findWeakBreak(buf: string, from: number): number {
  for (let i = from; i < buf.length; i++) {
    const ch = buf[i];
    if (ch === '。' || ch === '！' || ch === '？' || ch === '.' || ch === '!' || ch === '?'
        || ch === '，' || ch === '；' || ch === ',' || ch === ';' || ch === '\n' || ch === ' ') {
      return i;
    }
  }
  return -1;
}

/**
 * 旁白累积器 —— 把 NarrativeParser 的 onNarrationChunk 回调攒成段落级 Sentence。
 */
export function createNarrationAccumulator(emit: (para: string) => void) {
  let buf = '';
  return {
    push(text: string): void {
      buf += text;
      while (true) {
        const cut = findNarrationCut(buf);
        if (cut === null) break;
        const para = buf.slice(0, cut.end).trim();
        if (para) emit(para);
        buf = buf.slice(cut.consume);
      }
    },
    flush(): void {
      const trimmed = buf.trim();
      if (trimmed) emit(trimmed);
      buf = '';
    },
    pending(): number {
      return buf.length;
    },
  };
}
