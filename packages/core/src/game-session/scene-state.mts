import type { ScenePatch } from '#internal/tool-executor';
import type { SceneState, SpriteState } from '#internal/types';

export type SceneTransition = 'fade' | 'cut' | 'dissolve';

export interface AppliedScenePatch {
  scene: SceneState;
  transition?: SceneTransition;
}

type FullScenePatch = Extract<ScenePatch, { kind: 'full' }>;
type SingleSpritePatch = Extract<ScenePatch, { kind: 'single-sprite' }>;

export function applyScenePatchToState(
  currentScene: SceneState,
  patch: ScenePatch,
): AppliedScenePatch {
  switch (patch.kind) {
    case 'clear':
      return { scene: emptyScene() };
    case 'full':
      return applyFullScenePatch(currentScene, patch);
    case 'single-sprite':
      return applySingleSpritePatch(currentScene, patch);
  }
}

function emptyScene(): SceneState {
  return { background: null, sprites: [] };
}

function applyFullScenePatch(
  { background: currentBackground, sprites: currentSprites }: SceneState,
  { background, sprites, transition }: FullScenePatch,
): AppliedScenePatch {
  return {
    scene: {
      background: background !== undefined ? background : currentBackground,
      sprites: sprites !== undefined ? sprites : currentSprites,
    },
    transition,
  };
}

function applySingleSpritePatch(
  currentScene: SceneState,
  { sprite }: SingleSpritePatch,
): AppliedScenePatch {
  return {
    scene: {
      ...currentScene,
      sprites: upsertSprite(currentScene.sprites, sprite),
    },
  };
}

function upsertSprite(sprites: SpriteState[], sprite: SpriteState): SpriteState[] {
  const existing = sprites.findIndex(({ id }) => id === sprite.id);
  return existing >= 0
    ? sprites.map((current) => current.id === sprite.id ? sprite : current)
    : [...sprites, sprite];
}
