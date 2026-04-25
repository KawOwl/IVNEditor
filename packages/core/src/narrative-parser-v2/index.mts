/**
 * Narrative Parser v2 — Public API / 组合层
 *
 * 把 htmlparser2 的 callback-based streaming parser 适配成我们的纯 reducer。
 *
 * 组合式设计：
 *   - `tag-schema`：声明哪些 tag 合法（纯数据）
 *   - `state`：ParserState 形状 + 纯数据变换
 *   - `inheritance`：`(prev, pending, manifest) → resolved scene`（纯函数）
 *   - `reducer`：`(state, event, manifest) → { state, outputs }`（纯函数）
 *   - 本文件：用 htmlparser2 驱动 reducer，hold state 在闭包里
 *
 * 唯一的 mutation 在 htmlparser2 callback 边界（闭包 `state` 变量），
 * 且只通过 reducer 返回的新 state 赋值，不做局部 mutate。
 */

import { Parser as HtmlParser } from 'htmlparser2';
import type { Sentence, ScratchBlock, SceneState } from '#internal/types';
import {
  initialParserState,
  type ParserState,
  type ParserManifest,
  type DegradeEvent,
} from '#internal/narrative-parser-v2/state';
import { reduce, type ParserEvent } from '#internal/narrative-parser-v2/reducer';

export type { ParserManifest, DegradeEvent } from '#internal/narrative-parser-v2/state';
export {
  NPC_SPEAKER_PREFIX,
  isAdhocSpeaker,
  adhocDisplayName,
} from '#internal/narrative-parser-v2/tag-schema';

// ============================================================================
// 输出形状
// ============================================================================

/** `feed()` / `finalize()` 返回的增量产物。 */
export interface ParseBatch {
  readonly sentences: ReadonlyArray<Sentence>;
  readonly scratches: ReadonlyArray<ScratchBlock>;
  readonly degrades: ReadonlyArray<DegradeEvent>;
}

export const EMPTY_BATCH: ParseBatch = Object.freeze({
  sentences: [],
  scratches: [],
  degrades: [],
});

/** 外部暴露的 parser API。 */
export interface NarrativeParser {
  /** 喂一段 chunk，返回这次 parse 新产出的 sentences / scratches / degrades。 */
  feed(chunk: string): ParseBatch;
  /**
   * 告知流结束。未闭合的容器强制 close（truncated:true）。
   * 返回最后一批产物。调用后 parser 变为不可再喂。
   */
  finalize(): ParseBatch;
  /** 只读访问当前 state（debug / 测试用）。 */
  snapshot(): ParserState;
}

// ============================================================================
// 工厂
// ============================================================================

export interface CreateParserOptions {
  readonly manifest: ParserManifest;
  readonly turnNumber: number;
  readonly startIndex: number;
  readonly initialScene: SceneState;
}

export function createParser(opts: CreateParserOptions): NarrativeParser {
  // 闭包 state —— 整个组合层**唯一的** mutation 点。
  // reduce() 保证新 state 是纯值，下面只做"赋新引用"。
  let state: ParserState = initialParserState({
    turnNumber: opts.turnNumber,
    startIndex: opts.startIndex,
    initialScene: opts.initialScene,
  });

  // 一次 feed/finalize 内累积的输出（局部变量，不跨调用）
  let pendingBatch: MutableBatch = freshBatch();

  const applyEvent = (event: ParserEvent): void => {
    const { state: next, outputs } = reduce(state, event, opts.manifest);
    state = next;
    pendingBatch = appendToBatch(pendingBatch, outputs);
  };

  const htmlParser = new HtmlParser(
    {
      onopentag: (name, attrs) => {
        applyEvent({ type: 'opentag', name, attrs });
      },
      ontext: (data) => {
        applyEvent({ type: 'text', data });
      },
      onclosetag: (name) => {
        applyEvent({ type: 'closetag', name });
      },
      // 其余 callback 忽略（comment / cdata / pi / error 等）
    },
    // recognizeSelfClosing: 让 htmlparser2 把 `<sprite/>` 视作自闭合，
    // 否则默认会等配对 close tag。lowerCaseTags 统一小写化。
    { recognizeSelfClosing: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );

  const drain = (): ParseBatch => {
    const out: ParseBatch = {
      sentences: pendingBatch.sentences,
      scratches: pendingBatch.scratches,
      degrades: pendingBatch.degrades,
    };
    pendingBatch = freshBatch();
    return out;
  };

  return {
    feed(chunk) {
      if (state.finalized) return EMPTY_BATCH;
      htmlParser.write(chunk);
      return drain();
    },

    finalize() {
      if (state.finalized) return EMPTY_BATCH;
      // 顺序关键：先让 reducer 驱动栈 drain（未闭合容器 truncated:true），
      // 再 htmlparser2.end() 清它自己的 buffer。后者会对未闭合 tag 发
      // 合成的 closetag，但这时 state.finalized === true，reducer 会全部忽略。
      // 反过来做会让合成 closetag 先把栈 pop 掉（非 truncated），丢失截断信号。
      applyEvent({ type: 'finalize' });
      htmlParser.end();
      return drain();
    },

    snapshot() {
      return state;
    },
  };
}

// ============================================================================
// 内部可变 batch 累积器（仅本模块作用域使用）
// ============================================================================

interface MutableBatch {
  sentences: Sentence[];
  scratches: ScratchBlock[];
  degrades: DegradeEvent[];
}

function freshBatch(): MutableBatch {
  return { sentences: [], scratches: [], degrades: [] };
}

function appendToBatch(batch: MutableBatch, outputs: {
  readonly sentences: ReadonlyArray<Sentence>;
  readonly scratches: ReadonlyArray<ScratchBlock>;
  readonly degrades: ReadonlyArray<DegradeEvent>;
}): MutableBatch {
  // 为效率这里直接 push（局部 mutation，batch 只在一次 feed 内存活）
  for (const s of outputs.sentences) batch.sentences.push(s);
  for (const b of outputs.scratches) batch.scratches.push(b);
  for (const d of outputs.degrades) batch.degrades.push(d);
  return batch;
}

// ============================================================================
// Helper：从 ScriptManifest 构造 ParserManifest（给 GameSession 用的便利函数）
// ============================================================================

export interface ScriptManifestLike {
  readonly characters?: ReadonlyArray<{
    readonly id: string;
    readonly sprites?: ReadonlyArray<{ readonly id: string }>;
  }>;
  readonly backgrounds?: ReadonlyArray<{ readonly id: string }>;
}

/**
 * 从 ScriptManifest 的子集形状构造一个 ParserManifest。
 * 纯函数，输入不变。
 */
export function buildParserManifest(script: ScriptManifestLike): ParserManifest {
  const characters = new Set<string>();
  const moodsByChar = new Map<string, Set<string>>();
  for (const char of script.characters ?? []) {
    characters.add(char.id);
    const moods = new Set<string>();
    for (const s of char.sprites ?? []) moods.add(s.id);
    moodsByChar.set(char.id, moods);
  }
  const backgrounds = new Set<string>();
  for (const bg of script.backgrounds ?? []) backgrounds.add(bg.id);

  return {
    characters,
    moodsByChar: moodsByChar as ReadonlyMap<string, ReadonlySet<string>>,
    backgrounds,
  };
}
