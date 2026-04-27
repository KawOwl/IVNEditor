/**
 * DialogBox — VN 底部对话框
 *
 * 决策（M1 Q2 方案 A）：narration 和 dialogue 共用这个对话框；
 *   - dialogue：显示 pf.speaker 名 + 对话文本
 *   - narration：speaker 行隐藏（不显示名字），纯正文
 *   - scene_change：不渲染（调用方应该跳过）
 *
 * 不负责：
 *   - 推进游标（VNStage 在 Step 1.2 加）
 *   - 打字机（Step 1.4 加，先静态全显）
 *   - "等待叙事..."占位（sentence == null 时自己显示一条省略号）
 */

import type { Sentence, CharacterAsset } from '@ivn/core/types';
import { resolveSpeakerName } from '#internal/ui/play/vn/speaker-name';

type SignalInputSentence = Extract<Sentence, { kind: 'signal_input' }>;

export interface DialogBoxProps {
  /** 当前要展示的 Sentence；null = 等待叙事中 */
  sentence: Sentence | null;
  /** 查 speaker 显示名用 */
  characters: CharacterAsset[];
  /**
   * M1 Step 1.4：打字机逐字展示时 VNStageContainer 传入"当前已显示的文本子串"。
   * 不传 = 直接显示 sentence.text 原文（例如 backlog 回看、打字机禁用）。
   */
  displayText?: string;
  /**
   * 当前游标之后还有未读 Sentence → 显示"▼"提示玩家可以点击推进。
   */
  hasMore?: boolean;
  /**
   * LLM 正在生成（status='generating' 且游标已在末端）→ 显示"..."动画，
   * 让玩家知道"在写，稍等"而不是误以为已结束。
   */
  generating?: boolean;
  /**
   * 当 sentence.kind === 'player_input' 时，调用方可以传入紧邻在前的 signal_input
   * sentence。DialogBox 会在玩家回答上方先渲染一张询问卡片（hint + choices +
   * 选中项高亮），让玩家"看到自己是从哪些选项里选的"。
   * 对自由输入（玩家没点选项），调用方仍可传入 precedingSignal——卡片只是不
   * 高亮任何一项，与 Backlog 行为一致。
   */
  precedingSignal?: SignalInputSentence | null;
}

export function DialogBox({ sentence, characters, displayText, hasMore, generating, precedingSignal }: DialogBoxProps) {
  return (
    <div className="absolute inset-x-0 bottom-0 bg-zinc-950/90 backdrop-blur-sm border-t border-zinc-700/60">
      <div className="relative mx-auto max-w-4xl px-6 py-5 min-h-[8rem] max-h-[60vh] overflow-y-auto">
        {renderBody(sentence, characters, displayText, precedingSignal)}
        {/* 右下角状态指示：小齿轮准备 / 还有内容 / 两者都没有 → 空
         * 主路径流式期间显示——内容是稳定的（按 turn 顺序、不重排），所以
         * 只在右下角加角标而不遮挡对话框正文。
         * （rewrite 阶段才会盖住对话框；那是 RewriteOverlay 的事。） */}
        {generating && (
          <div
            className="absolute right-4 bottom-3 text-xs text-zinc-400 flex items-center gap-1"
            aria-label="dialog-generating"
          >
            <span
              className="inline-block text-zinc-300"
              aria-hidden="true"
              style={{ animation: 'spin 2.4s linear infinite' }}
            >
              ⚙
            </span>
            <span className="ml-0.5">小齿轮在准备下一轮内容…</span>
          </div>
        )}
        {!generating && hasMore && (
          <div
            className="absolute right-4 bottom-3 text-zinc-400 text-base animate-bounce"
            aria-label="dialog-has-more"
            title="点击/空格继续"
          >
            ▼
          </div>
        )}
      </div>
    </div>
  );
}

function renderBody(
  sentence: Sentence | null,
  characters: CharacterAsset[],
  displayText: string | undefined,
  precedingSignal: SignalInputSentence | null | undefined,
) {
  if (sentence === null) {
    return (
      <div className="flex items-center text-zinc-500" aria-label="dialog-waiting">
        <span className="animate-pulse">…</span>
      </div>
    );
  }

  if (sentence.kind === 'scene_change' || sentence.kind === 'signal_input') {
    // 场景切换 / signal_input 事件不在对话框显示；
    //   - scene_change 的视觉由 SceneBackground/SpriteLayer 呈现
    //   - signal_input 的交互由 game-store.choices 面板承担；backlog 才展示历史
    // game-store 的 advanceSentence 已自动跳过这两种 kind，通常走不到这里。
    // 兜底留空，以防上游游标意外停在这里（避免 runtime 崩）。
    return <div className="min-h-[2rem]" aria-label={`dialog-${sentence.kind}`} />;
  }

  // 打字机：如果 displayText 传了且 kind 是 narration/dialogue，用它；
  // 否则用 sentence.text（即 backlog / 禁用打字机场景）
  const textToShow = displayText ?? sentence.text;
  const isTyping = displayText !== undefined && displayText.length < sentence.text.length;

  if (sentence.kind === 'narration') {
    return (
      <div aria-label="dialog-narration">
        <p className="text-base leading-relaxed text-zinc-200 whitespace-pre-wrap">
          {textToShow}
          {isTyping && <span className="ml-0.5 inline-block h-4 w-[0.5ch] animate-pulse bg-zinc-400/60 align-text-bottom" />}
        </p>
      </div>
    );
  }

  if (sentence.kind === 'player_input') {
    // 玩家的回复——和 Backlog 中 player_input 的样式保持一致：左侧细 border
    // + 小号"我"标题 + 左对齐文字。
    // 如果调用方传了 precedingSignal（紧邻在前的 signal_input），先渲染一张
    // 询问卡片，让玩家看到"GM 当时给了哪几个选项 + 我选了哪一条"。这跟
    // Backlog 里 signal_input + player_input 配对展示的形态一致。
    const selectedIndex = (sentence as { selectedIndex?: number }).selectedIndex;
    return (
      <div aria-label="dialog-player-input" className="space-y-3">
        {precedingSignal && (
          <div className="rounded border border-amber-900/30 bg-amber-950/20 px-3 py-2">
            <div className="text-[10px] font-semibold text-amber-400/70 mb-1">💬 询问</div>
            <div className="text-sm leading-relaxed text-amber-100/80 whitespace-pre-wrap mb-1.5">
              {precedingSignal.hint}
            </div>
            {precedingSignal.choices.length > 0 && (
              <ol className="text-xs space-y-0.5 mt-1">
                {precedingSignal.choices.map((c, i) => {
                  const picked = i === selectedIndex;
                  return (
                    <li
                      key={i}
                      className={`pl-4 ${picked ? 'text-sky-300 font-medium' : 'text-zinc-500'}`}
                    >
                      {picked ? '→ ' : `${i + 1}. `}
                      {c}
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        )}
        <div className="border-l-2 border-sky-400/40 pl-3">
          <div className="mb-1 text-xs font-semibold text-sky-300/90">我</div>
          <p className="text-base leading-relaxed text-sky-100/80 whitespace-pre-wrap">
            {textToShow}
            {isTyping && <span className="ml-0.5 inline-block h-4 w-[0.5ch] animate-pulse bg-sky-300/60 align-text-bottom" />}
          </p>
        </div>
      </div>
    );
  }

  // dialogue
  const speakerName = resolveSpeakerName(sentence.pf.speaker, characters);
  return (
    <div aria-label="dialog-dialogue">
      <div className="mb-2 text-sm font-semibold text-amber-300">{speakerName}</div>
      <p className="text-base leading-relaxed text-zinc-100 whitespace-pre-wrap">
        {textToShow}
        {isTyping && <span className="ml-0.5 inline-block h-4 w-[0.5ch] animate-pulse bg-amber-300/60 align-text-bottom" />}
        {!isTyping && sentence.truncated && (
          <span className="ml-1 text-zinc-500" title="LLM 输出被截断">…（截断）</span>
        )}
      </p>
    </div>
  );
}

