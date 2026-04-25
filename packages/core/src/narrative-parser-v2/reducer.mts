/**
 * Narrative Parser v2 — Pure Reducer
 *
 * **纯函数** `(state, event) → { state, outputs }`。
 * 禁 IO，禁 class，禁闭包 state。全部通过参数传递、返回新对象。
 *
 * Event 由 `index.ts` 的 htmlparser2 胶水层翻译产生。本模块不直接依赖
 * htmlparser2。这样 reducer 可以被纯单测驱动（不过 DOM）。
 *
 * RFC §4.3 silent tolerance 的语义层全部在本文件实现：
 *   - dialogue missing speaker → 降级为 narration
 *   - sprite/bg 白名单不过 → drop，产 degrade（在 inheritance.ts）
 *   - 未知顶层标签 → 跳过 + degrade
 *   - finalize 时未闭合容器 → 强制 close + truncated:true
 */

import type {
  ParticipationFrame,
  Sentence,
  ScratchBlock,
  SpriteState,
} from '#internal/types';
import {
  TOP_LEVEL_BY_NAME,
  VISUAL_CHILD_BY_NAME,
  isTopLevelTag,
  isVisualChildTag,
  isValidPosition,
  type VisualChildTagSpec,
} from '#internal/narrative-parser-v2/tag-schema';
import {
  type ParserState,
  type ParserManifest,
  type PendingUnit,
  type ReducerResult,
  type ReducerOutputs,
  type DegradeEvent,
  EMPTY_OUTPUTS,
  concatOutputs,
  emptyPendingUnit,
  peekContainer,
  popContainer,
  pushContainer,
  replaceTop,
  identityResult,
} from '#internal/narrative-parser-v2/state';
import { resolveScene } from '#internal/narrative-parser-v2/inheritance';

// ============================================================================
// Event ADT
// ============================================================================

export type ParserEvent =
  | { readonly type: 'opentag'; readonly name: string; readonly attrs: Readonly<Record<string, string>> }
  | { readonly type: 'text'; readonly data: string }
  | { readonly type: 'closetag'; readonly name: string }
  | { readonly type: 'finalize' };

// ============================================================================
// 入口 reducer
// ============================================================================

export function reduce(
  state: ParserState,
  event: ParserEvent,
  manifest: ParserManifest,
): ReducerResult {
  if (state.finalized) return identityResult(state);

  switch (event.type) {
    case 'opentag':
      return onOpenTag(state, event.name, event.attrs, manifest);
    case 'text':
      return onText(state, event.data);
    case 'closetag':
      return onCloseTag(state, event.name, manifest);
    case 'finalize':
      return onFinalize(state, manifest);
  }
}

// ============================================================================
// opentag
// ============================================================================

function onOpenTag(
  state: ParserState,
  name: string,
  attrs: Readonly<Record<string, string>>,
  _manifest: ParserManifest,
): ReducerResult {
  // 在未知顶层标签内部 → 静默吞掉子元素（深度+1）
  if (state.unknownDepth > 0) {
    const deeper = isTopLevelTag(name) || !isVisualChildTag(name)
      ? state.unknownDepth + 1
      : state.unknownDepth;
    return { state: { ...state, unknownDepth: deeper }, outputs: EMPTY_OUTPUTS };
  }

  // 任何新的 opentag 到来，先把容器外累积的裸文本合并成一条 degrade 丢弃。
  // 之后再走正常的 top-level / visual-child / unknown 分支。
  const flushed = flushBareText(state);

  if (isTopLevelTag(name)) {
    return mergeResult(flushed, openTopLevel(flushed.state, name, attrs));
  }

  if (isVisualChildTag(name)) {
    return mergeResult(flushed, openVisualChild(flushed.state, name, attrs));
  }

  // 未知标签：顶层 → 记 degrade 并进入吞噬模式
  if (flushed.state.containerStack.length === 0) {
    return mergeResult(flushed, {
      state: { ...flushed.state, unknownDepth: 1 },
      outputs: {
        sentences: [],
        scratches: [],
        degrades: [{ code: 'unknown-toplevel-tag', detail: name }],
      },
    });
  }

  // 容器内部的未知子 tag：吞掉，不算 degrade（保守）
  return mergeResult(flushed, identityResult(flushed.state));
}

/**
 * 把两次 reducer step 的 outputs 合并。第二个 step 的 state 是权威 state
 * （两个 step 是顺序的：先 flush 再 real action）。
 */
function mergeResult(first: ReducerResult, second: ReducerResult): ReducerResult {
  if (
    first.outputs.sentences.length === 0 &&
    first.outputs.scratches.length === 0 &&
    first.outputs.degrades.length === 0
  ) {
    return second;
  }
  return {
    state: second.state,
    outputs: {
      sentences: [...first.outputs.sentences, ...second.outputs.sentences],
      scratches: [...first.outputs.scratches, ...second.outputs.scratches],
      degrades: [...first.outputs.degrades, ...second.outputs.degrades],
    },
  };
}

/**
 * 把当前 `bareTextBuffer` 合并成一条 degrade 后清空。
 * - 空 buffer / 全空白 → 清空 + identity，无 degrade
 * - 非空白 → emit 一条 `bare-text-outside-container`，detail 带累计文本前 80 字符
 *
 * 调用时机：每次 opentag（进新容器前清帐）+ finalize（流结束兜底）。
 */
function flushBareText(state: ParserState): ReducerResult {
  const raw = state.bareTextBuffer;
  if (raw.length === 0) return identityResult(state);
  const trimmed = raw.trim();
  const nextState: ParserState = { ...state, bareTextBuffer: '' };
  if (trimmed.length === 0) {
    return { state: nextState, outputs: EMPTY_OUTPUTS };
  }
  const detail = trimmed.length > 80 ? trimmed.slice(0, 80) + '...' : trimmed;
  return {
    state: nextState,
    outputs: {
      sentences: [],
      scratches: [],
      degrades: [{ code: 'bare-text-outside-container', detail }],
    },
  };
}

function openTopLevel(
  state: ParserState,
  name: string,
  attrs: Readonly<Record<string, string>>,
): ReducerResult {
  const spec = TOP_LEVEL_BY_NAME[name];
  if (!spec) return identityResult(state);
  const unit =
    spec.kind === 'dialogue'
      ? buildDialogueUnit(attrs)
      : emptyPendingUnit(spec.kind);
  return {
    state: { ...state, containerStack: pushContainer(state.containerStack, unit) },
    outputs: EMPTY_OUTPUTS,
  };
}

function buildDialogueUnit(attrs: Readonly<Record<string, string>>): PendingUnit {
  const speaker = attrs.speaker?.trim() ?? '';
  const speakerMissing = speaker.length === 0;

  const pf: ParticipationFrame = {
    speaker: speakerMissing ? '' : speaker,
    addressee: parseIdList(attrs.to),
    overhearers: parseIdList(attrs.hear),
    eavesdroppers: parseIdList(attrs.eavesdroppers),
  };

  return emptyPendingUnit('dialogue', {
    pf,
    rawSpeaker: speaker || undefined,
    speakerMissing,
  });
}

function parseIdList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed === '*') return ['*'];
  return trimmed
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ============================================================================
// opentag → visual child
// ============================================================================

function openVisualChild(
  state: ParserState,
  name: string,
  attrs: Readonly<Record<string, string>>,
): ReducerResult {
  const spec = VISUAL_CHILD_BY_NAME[name];
  if (!spec) return identityResult(state);
  const top = peekContainer(state.containerStack);
  if (!top) {
    // 顶层出现 <sprite/> 等：忽略（不应当，但不崩）
    return identityResult(state);
  }
  if (top.kind === 'scratch') {
    // <scratch> 内部视觉 tag 没意义，忽略
    return identityResult(state);
  }

  const missing = spec.requiredAttrs.filter((k) => !attrs[k]);
  if (missing.length > 0) {
    return {
      state,
      outputs: {
        sentences: [],
        scratches: [],
        degrades: [
          {
            code: spec.name === 'sprite' ? 'sprite-missing-attr' : 'bg-missing-attr',
            detail: missing.join(','),
          },
        ],
      },
    };
  }

  return applyVisualChildAtTop(state, spec, attrs);
}

function applyVisualChildAtTop(
  state: ParserState,
  spec: VisualChildTagSpec,
  attrs: Readonly<Record<string, string>>,
): ReducerResult {
  const degrades: DegradeEvent[] = [];

  const nextStack = replaceTop(state.containerStack, (top) => {
    switch (spec.name) {
      case 'background': {
        // missing 已在 openVisualChild 里排除过，这里可安全 narrow
        const scene = attrs.scene ?? '';
        // RFC §4.3: 多个 background → 取最后一个
        return { ...top, pendingBg: { scene } };
      }
      case 'sprite': {
        const position = attrs.position ?? '';
        if (!isValidPosition(position)) {
          degrades.push({
            code: 'sprite-invalid-position',
            detail: position,
          });
          return top;
        }
        const incoming: SpriteState = {
          id: attrs.char ?? '',
          emotion: attrs.mood ?? '',
          position,
        };
        const dedup = dedupSprites(top.pendingSprites, incoming);
        return { ...top, pendingSprites: dedup };
      }
      case 'stage':
        return { ...top, pendingClearStage: true };
    }
  });

  return {
    state: { ...state, containerStack: nextStack },
    outputs: degrades.length === 0
      ? EMPTY_OUTPUTS
      : { sentences: [], scratches: [], degrades },
  };
}

/**
 * RFC §4.3:
 *   - 同 char 不同 position → 取最后一个（覆盖）
 *   - 同 position 不同 char → 取最后一个（覆盖）
 *   - 其他 → append
 */
function dedupSprites(
  prev: ReadonlyArray<SpriteState>,
  incoming: SpriteState,
): ReadonlyArray<SpriteState> {
  const filtered = prev.filter(
    (s) => s.id !== incoming.id && s.position !== incoming.position,
  );
  return [...filtered, incoming];
}

// ============================================================================
// text
// ============================================================================

function onText(state: ParserState, data: string): ReducerResult {
  if (state.unknownDepth > 0) {
    return identityResult(state);
  }
  const top = peekContainer(state.containerStack);
  if (!top) {
    // 容器外裸文本 —— RFC §4.3 silent tolerance：不产 Sentence，
    // 只在离开该窗口时（下一次 opentag 或 finalize）合并成**一条** degrade。
    //
    // SAX 对 CJK 会逐 chunk 发 text 事件（`我先` / `查` / `一下` …），如果每个
    // chunk 独立产 sentence 会把 UI / Langfuse 搞得很乱。这里只 append 到 buffer，
    // 真正的 degrade / 丢弃发生在 flushBareText 里。
    return {
      state: { ...state, bareTextBuffer: state.bareTextBuffer + data },
      outputs: EMPTY_OUTPUTS,
    };
  }

  // 容器内部累积文本
  const nextStack = replaceTop(state.containerStack, (u) => ({
    ...u,
    textBuffer: u.textBuffer + data,
  }));
  return { state: { ...state, containerStack: nextStack }, outputs: EMPTY_OUTPUTS };
}

// ============================================================================
// closetag
// ============================================================================

function onCloseTag(
  state: ParserState,
  name: string,
  manifest: ParserManifest,
): ReducerResult {
  if (state.unknownDepth > 0) {
    return {
      state: { ...state, unknownDepth: state.unknownDepth - 1 },
      outputs: EMPTY_OUTPUTS,
    };
  }

  // 视觉子标签 close：htmlparser2 会发 onclosetag，但我们在 opentag 时
  // 就把效果落到 pending 里了，close 直接忽略。
  if (isVisualChildTag(name)) {
    return identityResult(state);
  }

  if (!isTopLevelTag(name)) {
    // 容器内的未知 tag close：忽略
    return identityResult(state);
  }

  const { rest, top } = popContainer(state.containerStack);
  if (!top) {
    // 闭合了一个没开过的 tag：忽略
    return identityResult(state);
  }

  // tag 名对得上才按 kind 走正常路径；对不上先 emit 栈顶，然后按名字再尝试
  // （silent tolerance：不崩）
  const spec = TOP_LEVEL_BY_NAME[name];
  if (!spec || spec.kind !== top.kind) {
    // mismatch：按栈顶 kind emit，保守行为
    return finalizeUnit(state, rest, top, manifest, /*truncated*/ false);
  }

  return finalizeUnit(state, rest, top, manifest, false);
}

// ============================================================================
// finalize（stream 被切断）
// ============================================================================

function onFinalize(state: ParserState, manifest: ParserManifest): ReducerResult {
  // 先兜底 flush 容器外残留的裸文本（最后一个容器已关但后面又出现了裸文本的情况）。
  const flushed = flushBareText(state);

  if (flushed.state.containerStack.length === 0) {
    return {
      state: { ...flushed.state, finalized: true },
      outputs: flushed.outputs,
    };
  }

  // 从栈顶开始逐层 truncated close。每次 finalizeUnit 会把栈顶弹掉并累积 outputs。
  const drained = repeatUntil(
    { state: flushed.state, outputs: flushed.outputs as ReducerOutputs },
    (r) => r.state.containerStack.length === 0,
    (r) => {
      const { rest, top } = popContainer(r.state.containerStack);
      if (!top) return r;
      const step = finalizeUnit(r.state, rest, top, manifest, true);
      return {
        state: step.state,
        outputs: concatOutputs(r.outputs, step.outputs),
      };
    },
  );

  return {
    state: { ...drained.state, finalized: true, containerStack: [] },
    outputs: drained.outputs,
  };
}

/**
 * 纯函数版本的 while 循环：反复 apply step 直到 predicate 为真。
 * 用以替代 for/while 的 imperative 循环（§2 原则 #7）。
 */
function repeatUntil<T>(
  initial: T,
  done: (v: T) => boolean,
  step: (v: T) => T,
): T {
  // 实现上仍要循环求值，但对外是纯函数：同输入同输出、无副作用。
  // mutation 只在局部 `current` 变量，不逃逸。
  let current = initial;
  while (!done(current)) {
    const next = step(current);
    if (Object.is(next, current)) return current; // 保护无限循环
    current = next;
  }
  return current;
}

// ============================================================================
// 单元 finalize（close 或 stream truncated 都走这里）
// ============================================================================

function finalizeUnit(
  state: ParserState,
  restStack: ReadonlyArray<PendingUnit>,
  unit: PendingUnit,
  manifest: ParserManifest,
  truncated: boolean,
): ReducerResult {
  if (unit.kind === 'scratch') {
    return finalizeScratch(state, restStack, unit);
  }

  const { scene, bgChanged, spritesChanged, degrades } = resolveScene(
    state.lastScene,
    unit,
    manifest,
  );

  const sceneDegrades: ReadonlyArray<DegradeEvent> = degrades;
  const truncDegrade: ReadonlyArray<DegradeEvent> = truncated
    ? [{ code: 'container-truncated', detail: unit.kind }]
    : [];

  const sentence = buildSentence(state, unit, scene, bgChanged, spritesChanged, truncated, manifest);
  const additionalDegrades = sentence.extraDegrades;

  return {
    state: {
      ...state,
      nextIndex: state.nextIndex + 1,
      lastScene: scene,
      containerStack: restStack,
    },
    outputs: {
      sentences: [sentence.sentence],
      scratches: [],
      degrades: [...sceneDegrades, ...truncDegrade, ...additionalDegrades],
    },
  };
}

function finalizeScratch(
  state: ParserState,
  restStack: ReadonlyArray<PendingUnit>,
  unit: PendingUnit,
): ReducerResult {
  const text = unit.textBuffer.trim();
  if (text.length === 0) {
    return {
      state: { ...state, containerStack: restStack },
      outputs: EMPTY_OUTPUTS,
    };
  }
  const block: ScratchBlock = {
    text,
    turnNumber: state.turnNumber,
    index: state.nextIndex,
  };
  return {
    state: {
      ...state,
      nextIndex: state.nextIndex + 1,
      containerStack: restStack,
    },
    outputs: { sentences: [], scratches: [block], degrades: [] },
  };
}

// ============================================================================
// Sentence 构造（dialogue / narration 合用）
// ============================================================================

interface BuildSentenceResult {
  readonly sentence: Sentence;
  readonly extraDegrades: ReadonlyArray<DegradeEvent>;
}

function buildSentence(
  state: ParserState,
  unit: PendingUnit,
  sceneRef: ReturnType<typeof resolveScene>['scene'],
  bgChanged: boolean,
  spritesChanged: boolean,
  truncated: boolean,
  manifest: ParserManifest,
): BuildSentenceResult {
  const text = normalizeText(unit.textBuffer);

  if (unit.kind === 'narration') {
    return {
      sentence: {
        kind: 'narration',
        text,
        sceneRef,
        turnNumber: state.turnNumber,
        index: state.nextIndex,
        bgChanged,
        spritesChanged,
        ...(truncated ? { truncated: true } : {}),
      },
      extraDegrades: [],
    };
  }

  // dialogue
  if (unit.speakerMissing) {
    // 降级为 narration
    return {
      sentence: {
        kind: 'narration',
        text,
        sceneRef,
        turnNumber: state.turnNumber,
        index: state.nextIndex,
        bgChanged,
        spritesChanged,
        ...(truncated ? { truncated: true } : {}),
      },
      extraDegrades: [{ code: 'dialogue-missing-speaker' }],
    };
  }

  const pf: ParticipationFrame = unit.pf ?? { speaker: unit.rawSpeaker ?? '' };
  const extraDegrades: DegradeEvent[] = [];
  if (pf.speaker && !manifest.characters.has(pf.speaker)) {
    extraDegrades.push({ code: 'dialogue-unknown-speaker', detail: pf.speaker });
  }

  return {
    sentence: {
      kind: 'dialogue',
      text,
      pf,
      sceneRef,
      turnNumber: state.turnNumber,
      index: state.nextIndex,
      bgChanged,
      spritesChanged,
      ...(truncated ? { truncated: true } : {}),
    },
    extraDegrades,
  };
}

/**
 * text buffer 的规范化：
 *   - 去掉首尾空白（但保留内部双换行，下游段落切分器依赖）
 *   - 连续空白（但非 \n\n）压缩为单空格
 *
 * 为了贴近 v1 行为，这里简化只做首尾 trim，更复杂的段落处理让消费方做。
 */
function normalizeText(buf: string): string {
  return buf.trim();
}
