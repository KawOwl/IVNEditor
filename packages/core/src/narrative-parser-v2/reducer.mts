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
  isAdhocSpeaker,
  isPronounSpeaker,
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
  manifest: ParserManifest,
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
    // <scratch> 内部出现的 top-level open tag 字面量（典型：LLM 在 scratch
    // 里讨论格式 "拆为多个 <narration> 单元"）。原本会触发
    // drainStackAsTruncated 把 scratch 强制截断，后续到 </scratch> 之前的内容
    // 跑进伪 narration 容器、污染玩家 UI（trace bab24e15-04ae 实测复现）。
    // scratch 是不渲染的内部思考容器，丢掉这个 tag 字面量不影响 UI；保留
    // scratch 容器存活直到看到真正的 </scratch> 才闭合。
    if (peekContainer(flushed.state.containerStack)?.kind === 'scratch') {
      return flushed;
    }
    return mergeResult(flushed, openTopLevel(flushed.state, name, attrs, manifest));
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
  manifest: ParserManifest,
): ReducerResult {
  const spec = TOP_LEVEL_BY_NAME[name];
  if (!spec) return identityResult(state);

  // RFC §3 三种顶层容器是平铺关系，不嵌套。如果新顶层 open 时栈非空，说明上
  // 一个容器从未正常闭合（典型场景：LLM 把 `</narration>` 写成 `</narrtion>`
  // 之类的 typo，机制上 onCloseTag 走了未知路径不 pop）。
  //
  // 不 drain 的话，新容器 push 在残留之上，等到 finalize 才统一 LIFO drain，
  // 残留的 sentence 会被分配到比当前容器**更晚**的 index，emit 顺序和文本顺
  // 序不一致——参见 carina trace（d6ef2af7）："narration1<typo>narration2<typo>
  // <dialogue>...</dialogue>" 流出来的对白 index 在两个本应铺垫的旁白之前。
  const drained = drainStackAsTruncated(state, manifest);

  const unit =
    spec.kind === 'dialogue'
      ? buildDialogueUnit(attrs)
      : emptyPendingUnit(spec.kind);
  return {
    state: { ...drained.state, containerStack: pushContainer(drained.state.containerStack, unit) },
    outputs: drained.outputs,
  };
}

/**
 * 把栈里所有未闭合容器按 LIFO 强制 finalize（truncated:true）。
 *
 * 调用时机：
 * - 新顶层 open（openTopLevel）→ 防 emit 顺序错位
 * - 流结束（onFinalize）→ 兜底
 *
 * 栈在新顶层 open 时通常只有 0 或 1 项（每次 open 都 drain 干净），
 * 所以 LIFO vs FIFO 的差异在实际场景里观察不到。多于 1 项是 LLM 连续
 * typo 的极端情况，按 LIFO 仍然是合理保守行为。
 */
function drainStackAsTruncated(
  state: ParserState,
  manifest: ParserManifest,
): ReducerResult {
  if (state.containerStack.length === 0) return identityResult(state);
  return repeatUntil(
    { state, outputs: EMPTY_OUTPUTS as ReducerOutputs },
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
    // 未知 close tag —— 典型场景是 LLM 写错字（`</narrtion>`、`</dialouge>`
    // 等）。RFC §4.3 silent tolerance：不崩、不强行映射回某个合法 kind，但
    // emit 一条 degrade 让 trace 留痕。容器本身保持挂在栈上，等下一个顶层
    // open（drainStackAsTruncated）或 finalize 强制关闭。
    return {
      state,
      outputs: {
        sentences: [],
        scratches: [],
        degrades: [{ code: 'unknown-close-tag', detail: name }],
      },
    };
  }

  // <scratch> 内部出现的非 scratch 的 top-level close 字面量（典型：LLM 在
  // scratch 里写完整的 `<narration>...</narration>` 字面量讨论结构）。和
  // onOpenTag 对称——不弹栈、不 emit、不 degrade，让 scratch 继续到真正的
  // </scratch> 才闭合。
  if (name !== 'scratch' && peekContainer(state.containerStack)?.kind === 'scratch') {
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

  // 栈非空时按 LIFO 逐层 truncated close。同一 helper 也被新顶层 open 复用。
  const drained = drainStackAsTruncated(flushed.state, manifest);

  return {
    state: { ...drained.state, finalized: true, containerStack: [] },
    outputs: concatOutputs(flushed.outputs, drained.outputs),
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

  const built = buildSentences(state, unit, scene, bgChanged, spritesChanged, truncated, manifest);
  const additionalDegrades = built.extraDegrades;

  return {
    state: {
      ...state,
      nextIndex: state.nextIndex + built.sentences.length,
      lastScene: scene,
      containerStack: restStack,
    },
    outputs: {
      sentences: built.sentences,
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

interface BuildSentencesResult {
  readonly sentences: ReadonlyArray<Sentence>;
  readonly extraDegrades: ReadonlyArray<DegradeEvent>;
}

/**
 * 把一个 `<dialogue>` / `<narration>` 容器的文本按 `\n\n` 切分成 1..N 条 Sentence，
 * 共享同一 sceneRef / PF（容器 = 视觉单元；段落 = 播放单元，UI 逐段打字机）。
 *
 * 分配规则：
 * - `sceneRef`、`pf`、`turnNumber` 所有段共享
 * - `index` 从 `state.nextIndex` 起逐段 +1
 * - `bgChanged` / `spritesChanged` 只贴在**第一条**（视觉变化只发生在进入容器时）
 * - `truncated` 只贴在**最后一条**（截断发生在容器末尾）
 * - `extraDegrades` 只在整容器级产出一次（与段数无关）
 *
 * 空文本容器（trim 后为空）→ 返回 0 条 Sentence，但保留 degrade（例如
 * dialogue-missing-speaker 仍然报告，避免"空 speaker + 空正文"这类异常被吞）。
 * 这和现有 `finalizeScratch` "空 scratch 不产 block" 的语义对齐。
 */
function buildSentences(
  state: ParserState,
  unit: PendingUnit,
  sceneRef: ReturnType<typeof resolveScene>['scene'],
  bgChanged: boolean,
  spritesChanged: boolean,
  truncated: boolean,
  manifest: ParserManifest,
): BuildSentencesResult {
  const paragraphs = splitParagraphs(unit.textBuffer);

  // 先算这个容器级的 extraDegrades（只产一次）
  let kind: 'narration' | 'dialogue';
  let pf: ParticipationFrame | null = null;
  const extraDegrades: DegradeEvent[] = [];

  if (unit.kind === 'narration') {
    kind = 'narration';
  } else if (unit.speakerMissing) {
    // dialogue 缺 speaker → 整容器降级 narration
    kind = 'narration';
    extraDegrades.push({ code: 'dialogue-missing-speaker' });
  } else {
    kind = 'dialogue';
    pf = unit.pf ?? { speaker: unit.rawSpeaker ?? '' };
    if (pf.speaker) {
      if (isAdhocSpeaker(pf.speaker)) {
        if (isPronounSpeaker(pf.speaker)) {
          // ad-hoc 后缀是中文代词（`__npc__你` 等）—— LLM 把第二人称代词
          // 当成 ad-hoc 显示名。prompt 已显式禁止；这里 emit pronoun degrade
          // 让 trace 可量化，UI 仍按 ad-hoc 渲染（不阻断生成）。
          extraDegrades.push({ code: 'dialogue-pronoun-as-speaker', detail: pf.speaker });
        } else {
          // ad-hoc 角色（`__npc__保安` 等）：合法的"白名单外但有意为之"。
          // emit 中性事件供 trace 量化使用，不算降级——dialogue 正常 emit，
          // pf.speaker 保留完整 raw 字符串，UI 渲染时 strip 前缀。
          extraDegrades.push({ code: 'dialogue-adhoc-speaker', detail: pf.speaker });
        }
      } else if (!manifest.characters.has(pf.speaker)) {
        // 真·杜撰 speaker（白名单外、又没声明 ad-hoc 前缀）：保留 dialogue
        // 但 emit degrade，方便 prompt 调优时追踪 LLM 漂移。
        extraDegrades.push({ code: 'dialogue-unknown-speaker', detail: pf.speaker });
      }
    }
  }

  if (paragraphs.length === 0) {
    // 整容器为空（e.g. `<narration></narration>` 或 `<dialogue speaker="x"/>`）：
    // 不产 Sentence，但 extraDegrades 仍然上报（方便调试）。
    return { sentences: [], extraDegrades };
  }

  const sentences: Sentence[] = paragraphs.map((text, i) => {
    const isFirst = i === 0;
    const isLast = i === paragraphs.length - 1;
    const base = {
      text,
      sceneRef,
      turnNumber: state.turnNumber,
      index: state.nextIndex + i,
      bgChanged: isFirst ? bgChanged : false,
      spritesChanged: isFirst ? spritesChanged : false,
      ...(truncated && isLast ? { truncated: true } : {}),
    };
    if (kind === 'narration') {
      return { kind: 'narration', ...base };
    }
    // dialogue：pf 在上面已 narrow 非空
    return { kind: 'dialogue', pf: pf!, ...base };
  });

  return { sentences, extraDegrades };
}

/**
 * 按 `\n\s*\n+`（空行，允许中间有空白字符）切段，每段 trim 并过滤空段。
 *
 * - 0 段（全空白）→ 返回 `[]`
 * - 无 `\n\n` → 返回 1 段（整段 trim）
 * - N 段 → 返回 N 段
 *
 * 空行分段是 v1 `findNarrationCut` 的第一优先级切分信号，这里和 v1 对齐语义，
 * 让 `<narration>` / `<dialogue>` 内部的自然段节奏能对应到多条 Sentence。
 */
function splitParagraphs(buf: string): string[] {
  const parts = buf.split(/\n[ \t]*\n+/);
  const out: string[] = [];
  for (const p of parts) {
    const t = p.trim();
    if (t.length > 0) out.push(t);
  }
  return out;
}
