/**
 * VNStage — VN 舞台容器
 *
 * 把 SceneBackground + SpriteLayer + DialogBox 堆成三层全屏渲染。
 * 纯 controlled 组件——不读 store、不处理推进逻辑；所有数据由调用方传入。
 * Step 1.2 会加一个 `<VNStageContainer>` 或 hook 负责 store 绑定 + 推进。
 *
 * 布局：
 *   - 外层 relative 容器填满父元素
 *   - absolute 堆 3 层 z-index（0 背景, 10 立绘, 20 对话框）
 *
 * 暂不接 scene_change 过渡动效（Step 1.5）。
 */

import type {
  Sentence,
  SceneState,
  CharacterAsset,
  BackgroundAsset,
} from '@ivn/core/types';
import { SceneBackground, type SceneTransition } from '#internal/ui/play/vn/SceneBackground';
import { SpriteLayer } from '#internal/ui/play/vn/SpriteLayer';
import { DialogBox } from '#internal/ui/play/vn/DialogBox';

type SignalInputSentence = Extract<Sentence, { kind: 'signal_input' }>;

export interface VNStageProps {
  /** 当前场景快照（背景 + 立绘） */
  scene: SceneState;
  /** 当前要展示的 Sentence；null = 等待中 */
  sentence: Sentence | null;
  /** 从 manifest 来的资产索引 */
  characters: CharacterAsset[];
  backgrounds: BackgroundAsset[];
  /** 整个 stage 的点击处理（Step 1.2 用来 advance / Step 1.4 用来 skip 打字机） */
  onClick?: () => void;
  /** M1 Step 1.4：打字机逐字展示；不传 = 直接全显 sentence.text */
  displayText?: string;
  /** M1 Step 1.5：最近一次 scene-change 的过渡类型 */
  transition?: SceneTransition;
  /** 游标后面还有未读 Sentence */
  hasMore?: boolean;
  /** LLM 正在生成中（玩家应该等待） */
  generating?: boolean;
  /**
   * 当 sentence 是 player_input 时，紧邻在前的 signal_input（如果有）。
   * DialogBox 用它在玩家回答上方显示询问卡片。
   */
  precedingSignal?: SignalInputSentence | null;
}

export function VNStage({ scene, sentence, characters, backgrounds, onClick, displayText, transition, hasMore, generating, precedingSignal }: VNStageProps) {
  return (
    <div
      className="relative h-full w-full overflow-hidden select-none"
      onClick={onClick}
      aria-label="vn-stage"
    >
      {/* z-0 背景 */}
      <div className="absolute inset-0 z-0">
        <SceneBackground backgroundId={scene.background} backgrounds={backgrounds} transition={transition} />
      </div>
      {/* z-10 立绘 */}
      <div className="absolute inset-0 z-10">
        <SpriteLayer sprites={scene.sprites} characters={characters} />
      </div>
      {/* z-20 对话框 */}
      <div className="absolute inset-x-0 bottom-0 z-20">
        <DialogBox
          sentence={sentence}
          characters={characters}
          displayText={displayText}
          hasMore={hasMore}
          generating={generating}
          precedingSignal={precedingSignal}
        />
      </div>
    </div>
  );
}
