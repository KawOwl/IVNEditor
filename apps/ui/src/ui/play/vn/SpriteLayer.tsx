/**
 * SpriteLayer — VN 立绘层
 *
 * 根据 SpriteState[] 渲染在场立绘，按 position 放到左 / 中 / 右三列。
 * 无 position 的默认走 center。
 *
 * 过渡动效（M1 Step 1.5）：
 *   - 进场：每个立绘 mount 时走 200ms fade-in（opacity 0 → 1）
 *   - 退场：立绘从 sprites[] 移除时直接消失（MVP 不做退场淡出，
 *     因为要跟踪"正在退场"的 sprite state 比较复杂，等需要再说）
 *
 * 资产 URL 兜底：
 *   - characters[].sprites[] 里有匹配且 assetUrl 非空 → <img>
 *   - 否则 → 圆角卡片 + 角色名 · 表情文字
 */

import { useEffect, useState } from 'react';
import type { SpriteState, CharacterAsset } from '@ivn/core/types';
import { getBackendUrl } from '@/lib/backend-url';

export interface SpriteLayerProps {
  /** 当前在场立绘（来自 SceneState.sprites） */
  sprites: SpriteState[];
  /** 剧本定义的角色资产索引（M2 从 manifest.characters 传入） */
  characters: CharacterAsset[];
}

const POSITION_STYLES: Record<'left' | 'center' | 'right', string> = {
  left: 'left-[12%] -translate-x-1/2',
  center: 'left-1/2 -translate-x-1/2',
  right: 'right-[12%] translate-x-1/2',
};

export function SpriteLayer({ sprites, characters }: SpriteLayerProps) {
  return (
    <div className="pointer-events-none absolute inset-0" aria-label="sprite-layer">
      {sprites.map((sprite) => (
        <Sprite key={`${sprite.id}-${sprite.position ?? 'center'}`} sprite={sprite} characters={characters} />
      ))}
    </div>
  );
}

interface SpriteProps {
  sprite: SpriteState;
  characters: CharacterAsset[];
}

function Sprite({ sprite, characters }: SpriteProps) {
  const position = sprite.position ?? 'center';
  const character = characters.find((c) => c.id === sprite.id);
  const spriteAsset = character?.sprites.find((s) => s.id === sprite.emotion);
  const assetUrl = spriteAsset?.assetUrl;
  const displayName = character?.displayName ?? sprite.id;
  const emotionLabel = spriteAsset?.label ?? sprite.emotion;

  const posClass = POSITION_STYLES[position];

  // 进场 fade-in：mount 时 opacity 0，下一帧变成 1，200ms 过渡
  const [opacity, setOpacity] = useState(0);
  // M4：图加载失败 → 回落占位卡片
  const [imgFailed, setImgFailed] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setOpacity(1));
    return () => cancelAnimationFrame(raf);
  }, []);
  const fadeStyle = { opacity, transition: 'opacity 200ms ease-in-out' } as const;

  if (assetUrl && !imgFailed) {
    const resolvedUrl = assetUrl.startsWith('http') ? assetUrl : `${getBackendUrl()}${assetUrl}`;
    return (
      <img
        src={resolvedUrl}
        alt={`${displayName} · ${emotionLabel}`}
        className={`absolute bottom-0 ${posClass} h-[85%] w-auto object-contain object-bottom`}
        style={fadeStyle}
        onError={() => setImgFailed(true)}
      />
    );
  }

  // 占位卡片（无 URL 或加载失败）
  return (
    <div
      className={`absolute bottom-[18%] ${posClass} flex h-48 w-32 flex-col items-center justify-center rounded-lg border border-zinc-600 bg-zinc-800/70 text-center text-zinc-300 shadow-lg`}
      style={fadeStyle}
      aria-label={`sprite-placeholder-${sprite.id}-${sprite.emotion}`}
    >
      <div className="text-sm font-medium">{displayName}</div>
      <div className="mt-1 text-xs text-zinc-500">· {emotionLabel} ·</div>
    </div>
  );
}
