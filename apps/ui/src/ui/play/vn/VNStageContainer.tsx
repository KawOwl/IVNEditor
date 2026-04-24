/**
 * VNStageContainer — store 绑定 + 推进逻辑
 *
 * 职责：把 store 里的 `parsedSentences / currentScene / visibleSentenceIndex`
 * 喂给 pure 组件 `VNStage`；监听点击和键盘推进游标。
 *
 * 推进规则（M1 Step 1.2，click-to-advance）：
 *   - 点击 stage 任何位置 / Space / Enter / → 任一按键触发 advanceSentence()
 *   - 游标已在末尾时再按无效果，对话框显示 "…"（DialogBox 兜底）
 *
 * 注意：
 *   - 只渲染 `parsedSentences[visibleSentenceIndex]`，不是 `last`
 *   - 这样新 Sentence 到达时不会"跳"过玩家没看的内容
 *   - 首次追加时 appendSentence 会把 null → 0，让第一句自动出现
 *
 * 挂载前调用方应确保 manifest 的 characters / backgrounds 已传入，
 * 用于资产查找和 speaker displayName 解析。
 */

import { useCallback, useEffect } from 'react';
import { useGameStore } from '@/stores/game-store';
import { VNStage } from '#internal/ui/play/vn/VNStage';
import { Backlog } from '#internal/ui/play/vn/Backlog';
import { useDialogTypewriter } from '#internal/ui/play/vn/useDialogTypewriter';
import { getTypewriterSpeed } from '#internal/ui/play/typewriter-speed';
import type { CharacterAsset, BackgroundAsset, Sentence } from '@ivn/core/types';

export interface VNStageContainerProps {
  characters: CharacterAsset[];
  backgrounds: BackgroundAsset[];
}

export function VNStageContainer({ characters, backgrounds }: VNStageContainerProps) {
  const parsedSentences = useGameStore((s) => s.parsedSentences);
  const currentScene = useGameStore((s) => s.currentScene);
  const visibleSentenceIndex = useGameStore((s) => s.visibleSentenceIndex);
  const advanceSentence = useGameStore((s) => s.advanceSentence);
  const lastSceneTransition = useGameStore((s) => s.lastSceneTransition);
  const status = useGameStore((s) => s.status);

  // 当前展示哪一句？
  //   - visibleSentenceIndex === null → 没开始/刚 reset，对话框显示 "…"
  //   - 否则取 parsedSentences[index]
  const sentence: Sentence | null =
    visibleSentenceIndex === null ? null : parsedSentences[visibleSentenceIndex] ?? null;

  // 展示哪个 scene？
  //   - 用当前 Sentence 的 sceneRef（保持"Sentence 说话时的场景"一致）
  //   - 但玩家还没看到任何 Sentence 时（index=null）用 store.currentScene
  //     （defaultScene 经过 seedOpeningSentences 或初始 setCurrentScene 塞进来）
  const sceneToShow =
    sentence === null
      ? currentScene
      : sentence.kind === 'scene_change'
        ? sentence.scene
        : sentence.sceneRef;

  // --- Step 1.4：Sentence 级打字机 ---
  //
  // 当前 Sentence 是 narration/dialogue 时走打字机；scene_change / null 跳过
  // （反正对话框里不渲染文本）。cps 从 localStorage 读，用户在 PlayPage 的
  // 设置 popover 里能调。
  const fullText =
    sentence && (sentence.kind === 'narration' || sentence.kind === 'dialogue')
      ? sentence.text
      : '';
  const cps = getTypewriterSpeed();
  const typewriter = useDialogTypewriter(fullText, cps);

  // click 行为：
  //   - 打字机进行中 → skipToEnd 直接全显
  //   - 已经全显 → advanceSentence 推进到下一句
  //
  // 注：choice 待选时**不**强制拦截 click。玩家可能还在读前面的 Sentence，
  // 应该能继续点到末尾看完，然后再选 choice。等所有 Sentence 读完后，
  // advanceSentence 自动 cap 在末尾（DialogBox 显示 "…"），自然就只剩选项
  // 按钮能交互。
  const handleClick = useCallback(() => {
    if (fullText.length > 0 && !typewriter.done) {
      typewriter.skipToEnd();
      return;
    }
    advanceSentence();
  }, [fullText.length, typewriter, advanceSentence]);

  // 键盘推进（同样的 skip/advance 逻辑）
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      // 编辑框聚焦时不响应（避免玩家输入 choices/textarea 被这里吞键）
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowRight') {
        e.preventDefault();
        if (fullText.length > 0 && !typewriter.done) {
          typewriter.skipToEnd();
          return;
        }
        advanceSentence();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [advanceSentence, fullText.length, typewriter]);

  // 游标之后还有未读 Sentence？（跳过 scene_change / signal_input 两种跳过型）
  const hasMore = (() => {
    if (visibleSentenceIndex === null) return false;
    for (let i = visibleSentenceIndex + 1; i < parsedSentences.length; i++) {
      const kind = parsedSentences[i]?.kind;
      if (kind !== 'scene_change' && kind !== 'signal_input') return true;
    }
    return false;
  })();

  // LLM 正在生成 + 打字机已经完成 + 没有更多 Sentence 可读 → 显示 "生成中" 指示
  // （打字机进行中自然有光标动画；已经看到新 sentence 时也不用冗余提示）
  const generating =
    status === 'generating' &&
    !hasMore &&
    (fullText.length === 0 || typewriter.done);

  return (
    <div className="relative h-full w-full">
      <VNStage
        scene={sceneToShow}
        sentence={sentence}
        characters={characters}
        backgrounds={backgrounds}
        onClick={handleClick}
        displayText={fullText.length > 0 ? typewriter.displayed : undefined}
        transition={lastSceneTransition}
        hasMore={hasMore && typewriter.done}
        generating={generating}
      />
      {/* Backlog drawer 挂在 stage 之外，避免它的点击被 stage click 吞掉 */}
      <Backlog characters={characters} />
    </div>
  );
}
