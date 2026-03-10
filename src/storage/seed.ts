/**
 * Seed data — wraps existing static JSON assets into a ScriptBundle
 * for the built-in default script.
 */

import type { ScriptBundle } from './storage-interface';
import type { CharacterState, GOAPAction, WorldEvent } from '../memory/schemas';

// Static imports (same data that was previously hardcoded in App.tsx)
import liyaData from '../data/characters/liya.json';
import guardCaptainData from '../data/characters/guard-captain.json';
import chapter1Data from '../data/world-events/chapter1.json';
import goapActionsData from '../data/goap-actions.json';

export const BUILTIN_SCRIPT_ID = 'builtin-chapter1';

export function createBuiltinScript(): ScriptBundle {
  return {
    metadata: {
      id: BUILTIN_SCRIPT_ID,
      name: '第一章：风起',
      description: '莉娅·艾文斯 — 没落贵族的末裔，在边境小镇追寻家族覆灭的真相',
      author: '内置剧本',
      createdAt: 0,
      updatedAt: 0,
      version: 1,
      source: 'builtin',
    },
    characters: [
      liyaData as CharacterState,
      guardCaptainData as CharacterState,
    ],
    chapters: [
      {
        chapter: chapter1Data.chapter,
        events: chapter1Data.events as WorldEvent[],
        locations: chapter1Data.locations,
      },
    ],
    goapActions: goapActionsData as unknown as GOAPAction[],
  };
}
