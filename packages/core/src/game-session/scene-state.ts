import type { ScenePatch } from '../tool-executor';
import type { SceneState } from '../types';

export type SceneTransition = 'fade' | 'cut' | 'dissolve';

export interface AppliedScenePatch {
  scene: SceneState;
  transition?: SceneTransition;
}

export function applyScenePatchToState(
  currentScene: SceneState,
  patch: ScenePatch,
): AppliedScenePatch {
  if (patch.kind === 'clear') {
    return { scene: { background: null, sprites: [] } };
  }

  if (patch.kind === 'full') {
    return {
      scene: {
        background: patch.background !== undefined ? patch.background : currentScene.background,
        sprites: patch.sprites !== undefined ? patch.sprites : currentScene.sprites,
      },
      transition: patch.transition,
    };
  }

  const existing = currentScene.sprites.findIndex((sprite) => sprite.id === patch.sprite.id);
  const nextSprites = [...currentScene.sprites];
  if (existing >= 0) {
    nextSprites[existing] = patch.sprite;
  } else {
    nextSprites.push(patch.sprite);
  }

  return {
    scene: {
      ...currentScene,
      sprites: nextSprites,
    },
  };
}
