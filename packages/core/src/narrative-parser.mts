/**
 * Narrative Parser — XML-lite 流式叙事协议解析器
 *
 * 输入：LLM 生成的 text-delta chunks（不保证按 tag 边界切分）
 * 输出：事件流——narration 增量、dialogue 开始/增量/结束
 *
 * 协议见 engine-rules.ts 的"叙事输出格式（XML-lite）"段：
 *   - <d s="..." to="..." hear="..." eav="...">内容</d>  对话
 *   - 标签外的文本                                        旁白
 *
 * 场景切换（change_scene / change_sprite / clear_stage）不走文本解析，
 * 走 tool call 通道。解析器不关心。
 *
 * 设计目标：
 *   1. **增量**：chunk 逐块喂进来，立刻出事件（支持打字机效果）
 *   2. **容错**：遇到坏 tag 降级为旁白，不崩
 *   3. **末尾降级闭合**：finalize() 时未闭合的 <d> 自动闭合（truncated:true）
 *
 * 用法：
 *   const parser = new NarrativeParser({
 *     onNarrationChunk: (text) => ...,
 *     onDialogueStart: (pf) => ...,
 *     onDialogueChunk: (text) => ...,
 *     onDialogueEnd: (pf, fullText, truncated) => ...,
 *   });
 *   parser.push(chunk);          // 每收到 text-delta 调一次
 *   parser.finalize();           // 流结束时调（处理未闭合 tag）
 */

import type { ParticipationFrame } from '#internal/types';
import {
  createParser as createParserV2,
  buildParserManifest,
} from '#internal/narrative-parser-v2';

export interface NarrativeParserCallbacks {
  /** 旁白文本增量。可能同一段被分多次调 callback。 */
  onNarrationChunk?: (text: string) => void;
  /** <d> 标签开始时触发，传入解析后的 PF。 */
  onDialogueStart?: (pf: ParticipationFrame) => void;
  /** <d> 内容增量。仅在 onDialogueStart 和 onDialogueEnd 之间触发。 */
  onDialogueChunk?: (text: string) => void;
  /** <d> 标签结束。truncated=true 表示末尾降级闭合（流被截断）。 */
  onDialogueEnd?: (pf: ParticipationFrame, fullText: string, truncated: boolean) => void;
  /** 调试：一个完整句子（旁白段或 dialogue）产出时触发（可选）。 */
  onSentenceComplete?: (kind: 'narration' | 'dialogue', text: string) => void;
}

type ParserMode =
  | 'OUTSIDE'          // 外部文本（旁白或 tag 间空白）
  | 'IN_TAG_OPEN'      // 看到 <，等 tag 名
  | 'IN_D_ATTRS'       // <d ... 等属性结束（>）
  | 'IN_D_BODY'        // <d> 内部，text 进入 dialogue
  | 'IN_CLOSE_TAG'     // 看到 </，等 tag 名
  | 'IN_UNKNOWN_TAG';  // 未识别的 tag，字符照常进入但不当 tag 处理

export class NarrativeParser {
  private buffer = '';            // 待处理的字符缓冲（跨 chunk）
  private mode: ParserMode = 'OUTSIDE';
  private currentPF: ParticipationFrame | null = null;
  private currentDialogueText = '';
  private narrationBuffer = '';   // 外部文本在 flush 时一并 emit
  private narrationPendingFlush = false;
  private finalized = false;

  constructor(private cb: NarrativeParserCallbacks = {}) {}

  /**
   * 喂入一段 LLM 输出的增量文本。
   * 解析器会尽力 emit 能确认的事件，不能确认的留在 buffer。
   */
  push(chunk: string): void {
    if (this.finalized) return;
    this.buffer += chunk;
    this.drain();
  }

  /**
   * 流结束时调用。处理 buffer 里剩余的内容：
   *   - OUTSIDE：flush 剩余旁白
   *   - IN_D_BODY：末尾降级，把当前 dialogue 当 truncated 结束
   *   - 其他异常状态：尽量保留内容作为旁白
   */
  finalize(): void {
    if (this.finalized) return;
    this.finalized = true;

    switch (this.mode) {
      case 'OUTSIDE':
        if (this.buffer) {
          this.narrationBuffer += this.buffer;
          this.buffer = '';
        }
        this.flushNarration();
        break;

      case 'IN_TAG_OPEN':
      case 'IN_CLOSE_TAG':
        // 一个孤悬的 "<" 或 "</"——当作旁白
        this.narrationBuffer += this.buffer;
        this.buffer = '';
        this.flushNarration();
        break;

      case 'IN_D_ATTRS':
        // <d 还没看到 > 就结束，忽略（没有可用 PF）
        this.buffer = '';
        this.mode = 'OUTSIDE';
        this.flushNarration();
        break;

      case 'IN_D_BODY': {
        // 未闭合的 dialogue —— truncated 闭合
        if (this.buffer) {
          this.currentDialogueText += this.buffer;
          this.cb.onDialogueChunk?.(this.buffer);
          this.buffer = '';
        }
        const pf = this.currentPF ?? { speaker: 'unknown' };
        // trim 首尾空白——防止 `<d s=".">\nhello\n</d>` 带出前后换行
        const trimmedTextEnd = this.currentDialogueText.trim();
        this.cb.onDialogueEnd?.(pf, trimmedTextEnd, true);
        this.cb.onSentenceComplete?.('dialogue', trimmedTextEnd);
        this.currentPF = null;
        this.currentDialogueText = '';
        this.mode = 'OUTSIDE';
        break;
      }

      case 'IN_UNKNOWN_TAG':
        // 未识别 tag 内的内容——当旁白
        this.narrationBuffer += this.buffer;
        this.buffer = '';
        this.mode = 'OUTSIDE';
        this.flushNarration();
        break;
    }
  }

  /**
   * 主循环——尽量 emit 能确认的内容，不能确认的留 buffer 等下一个 chunk。
   */
  private drain(): void {
    while (this.buffer.length > 0) {
      if (this.mode === 'OUTSIDE') {
        // 找下一个 "<" 或吃完整段 buffer
        const ltIdx = this.buffer.indexOf('<');
        if (ltIdx === -1) {
          // 全是纯文本。立刻 flush —— 如果本 chunk 没有 `<`，下一 chunk 要么
          // 继续纯文本（再 flush 一段 narration），要么开新 `<d>` tag（这是
          // dialogue 的干净边界，不会和上一段 narration 拼错）。
          //
          // 历史 bug：这里原本 return 不 flush，希望累积到下一个 `<` 再一起
          // emit。结果"完全不带 XML 标签的叙事"永远触发不了 flush，VN UI
          // 只能等 finalize() —— 但 signal_input_needed 会在 finalize 前挂起，
          // 玩家看到的就是"只有选项没有叙事"。
          this.narrationBuffer += this.buffer;
          this.buffer = '';
          this.narrationPendingFlush = true;
          this.flushNarration();
          return;
        }
        // "<" 之前是旁白
        if (ltIdx > 0) {
          this.narrationBuffer += this.buffer.slice(0, ltIdx);
          this.narrationPendingFlush = true;
        }
        this.buffer = this.buffer.slice(ltIdx);
        // 先 flush 已累积的旁白，让打字机立刻看到
        this.flushNarration();
        // 切到 IN_TAG_OPEN 判断标签类型
        this.mode = 'IN_TAG_OPEN';
        continue;
      }

      if (this.mode === 'IN_TAG_OPEN') {
        // buffer 以 "<" 开头
        if (this.buffer.length < 2) return; // 等下个 chunk
        const second = this.buffer[1];
        if (second === '/') {
          // </... 闭合标签
          this.mode = 'IN_CLOSE_TAG';
          continue;
        }
        // 识别 <d ...> 还是其他
        // 需要看第 2 个字符是否是 'd' 且后跟空白或 '>'
        if (second === 'd' && (this.buffer.length < 3 || /[\s>]/.test(this.buffer[2]!))) {
          // 是 <d，找 >
          const gtIdx = this.buffer.indexOf('>');
          if (gtIdx === -1) {
            // 属性还没完整，等下个 chunk
            // 但为了避免 buffer 无限增长（LLM 写了一个 "<" 但不是 tag），
            // 设一个宽松上限：500 字符还没见 >，认为是坏 tag，降级
            if (this.buffer.length > 500) {
              this.narrationBuffer += this.buffer;
              this.buffer = '';
              this.mode = 'OUTSIDE';
              this.flushNarration();
            }
            return;
          }
          // <d ATTRS>
          const attrsStr = this.buffer.slice(2, gtIdx).trim();
          const pf = parseDialogueAttrs(attrsStr);
          this.currentPF = pf;
          this.currentDialogueText = '';
          this.cb.onDialogueStart?.(pf);
          this.buffer = this.buffer.slice(gtIdx + 1);
          this.mode = 'IN_D_BODY';
          continue;
        }
        // 其他 tag（<scene> / <spr/> / 未知） —— 跳过到其 '>'
        this.mode = 'IN_UNKNOWN_TAG';
        continue;
      }

      if (this.mode === 'IN_CLOSE_TAG') {
        // buffer 以 "</" 开头
        if (this.buffer.length < 3) return;
        const gtIdx = this.buffer.indexOf('>');
        if (gtIdx === -1) {
          if (this.buffer.length > 100) {
            // 坏的闭合标签，降级
            this.narrationBuffer += this.buffer;
            this.buffer = '';
            this.mode = 'OUTSIDE';
            this.flushNarration();
          }
          return;
        }
        const tagName = this.buffer.slice(2, gtIdx).trim();
        if (tagName === 'd' && this.currentPF) {
          // 正常闭合 <d>
          const trimmedDlg = this.currentDialogueText.trim();
          this.cb.onDialogueEnd?.(this.currentPF, trimmedDlg, false);
          this.cb.onSentenceComplete?.('dialogue', trimmedDlg);
          this.currentPF = null;
          this.currentDialogueText = '';
        }
        // 其他 </...> 忽略（<scene> 等不是 body 结构，直接推进）
        this.buffer = this.buffer.slice(gtIdx + 1);
        this.mode = 'OUTSIDE';
        continue;
      }

      if (this.mode === 'IN_D_BODY') {
        // 找下一个 </
        const closeIdx = this.buffer.indexOf('</');
        if (closeIdx === -1) {
          // 没有 </ 。但要小心：buffer 末尾如果是单独一个 '<'，
          // 可能是下一 chunk 带过来的 '/d>' 的前半，要保留不 emit。
          const safeLen =
            this.buffer.endsWith('<') ? this.buffer.length - 1 : this.buffer.length;
          if (safeLen > 0) {
            const text = this.buffer.slice(0, safeLen);
            this.currentDialogueText += text;
            this.cb.onDialogueChunk?.(text);
          }
          this.buffer = this.buffer.slice(safeLen);
          return; // 等下个 chunk
        }
        if (closeIdx > 0) {
          const text = this.buffer.slice(0, closeIdx);
          this.currentDialogueText += text;
          this.cb.onDialogueChunk?.(text);
        }
        this.buffer = this.buffer.slice(closeIdx);
        this.mode = 'IN_CLOSE_TAG';
        continue;
      }

      if (this.mode === 'IN_UNKNOWN_TAG') {
        // 跳到 > 为止，内容丢弃（scene/spr 等由 tool call 处理，不进文本流）
        const gtIdx = this.buffer.indexOf('>');
        if (gtIdx === -1) {
          if (this.buffer.length > 500) {
            // 坏 tag 降级到旁白
            this.narrationBuffer += this.buffer;
            this.buffer = '';
            this.mode = 'OUTSIDE';
            this.flushNarration();
          }
          return;
        }
        this.buffer = this.buffer.slice(gtIdx + 1);
        this.mode = 'OUTSIDE';
        continue;
      }
    }
  }

  private flushNarration(): void {
    if (!this.narrationPendingFlush && !this.narrationBuffer) return;
    if (this.narrationBuffer) {
      // 只过滤"纯空白" buffer（dialogue 之间的 `\n\n` 分隔符之类）。
      // **保留**原文 —— 段落内部的 `\n\n` 是下游段落级切分器识别段落的信号；
      // 之前用 .trim() 会误把首尾的 `\n\n` 吃掉，导致多段旁白被拼成一段。
      // 首尾多余的空白由最终 Sentence 下游（game-session 的 accumulator）再
      // 统一 trim，职责边界更清晰。
      if (this.narrationBuffer.trim().length > 0) {
        this.cb.onNarrationChunk?.(this.narrationBuffer);
        this.cb.onSentenceComplete?.('narration', this.narrationBuffer);
      }
      this.narrationBuffer = '';
    }
    this.narrationPendingFlush = false;
  }

  /** 诊断：当前 mode */
  getMode(): ParserMode {
    return this.mode;
  }
}

/**
 * 解析 <d ATTRS> 里的 ATTRS 为 ParticipationFrame。
 *
 * 支持的语法变体（宽松）：
 *   s="sakuya"
 *   s='sakuya'
 *   s=sakuya         （无引号，不推荐但兼容）
 *   to="yuki,nanami" → addressee: ['yuki', 'nanami']
 *   to="*"           → addressee: ['*']
 *   hear="teacher"
 *   eav="spy,agent"  → eavesdroppers: ['spy', 'agent']
 *
 * 未知属性忽略。speaker（s=）必填，缺失时 speaker='unknown' 并返回。
 */
export function parseDialogueAttrs(attrsStr: string): ParticipationFrame {
  const attrs: Record<string, string> = {};
  // 宽松匹配：name="value" | name='value' | name=value（无引号到空白或 /）
  const re = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s/>]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrsStr)) !== null) {
    const key = m[1]!;
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    attrs[key] = value;
  }

  const splitList = (v: string | undefined): string[] | undefined => {
    if (!v) return undefined;
    const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
    return parts.length > 0 ? parts : undefined;
  };

  return {
    speaker: attrs.s ?? attrs.speaker ?? 'unknown',   // 宽松：长名也接受
    addressee: splitList(attrs.to ?? attrs.addressee),
    overhearers: splitList(attrs.hear ?? attrs.overhearers),
    eavesdroppers: splitList(attrs.eav ?? attrs.eavesdroppers),
  };
}

/**
 * 从 v2 协议原文提取纯文本 —— 走 narrative-parser-v2 权威解析，保留 narration
 * 段落文字 + dialogue 内部文字，标签本身（含 `<scratch>` / `<background/>` /
 * `<sprite/>` / `<stage/>`）被去掉。
 *
 * 用途：
 *   - playthroughs.preview 字段（避免把 `<dialogue speaker="...">` 裸标签带到
 *     UI 游玩记录列表）
 *   - 未来 backlog 搜索 / 诊断面板等需要纯文本视图的场景
 *
 * 复用 v2 parser 的收益（对比 regex）：
 *   - parser 已经处理了未闭合标签截断、属性变体、嵌套降级等 edge case
 *   - 和运行时 streaming 解析共用同一份语义，协议演进自动跟随
 *
 * preview 场景不需要 manifest 校验（不关心 ad-hoc speaker 是否合规），传空
 * manifest 即可；scratch 块本就不进 sentences，自动被丢弃。
 */
export function extractPlainText(xmlLite: string): string {
  if (!xmlLite) return '';
  const parser = createParserV2({
    manifest: buildParserManifest({}),
    turnNumber: 0,
    startIndex: 0,
    initialScene: { background: null, sprites: [] },
  });
  const batch1 = parser.feed(xmlLite);
  const batch2 = parser.finalize();
  const parts: string[] = [];
  for (const s of [...batch1.sentences, ...batch2.sentences]) {
    if (s.kind === 'narration' || s.kind === 'dialogue') {
      parts.push(s.text);
    }
  }
  return parts.join('');
}
