/**
 * App — 主应用布局
 *
 * 三区布局：
 *   - NarrativeView: 叙事区域（可滚动，占满剩余空间）
 *   - InputPanel: 输入区域（底部固定）
 *   - DebugPanel: 调试面板（底部可折叠）
 */

import { useCallback } from 'react';
import { NarrativeView } from './NarrativeView';
import { InputPanel } from './InputPanel';
import { DebugPanel } from './DebugPanel';
import { useGameStore } from '../stores/game-store';

export function App() {
  const appendEntry = useGameStore((s) => s.appendEntry);

  const handlePlayerInput = useCallback(
    (text: string) => {
      // Append player input to narrative
      appendEntry({ role: 'pc', content: text });

      // TODO: In Step 1.9, this will trigger the game loop:
      // 1. Store input in memory
      // 2. Assemble context
      // 3. Call LLM
      // 4. Advance flow
    },
    [appendEntry],
  );

  return (
    <div className="h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      {/* Header */}
      <header className="flex-none px-6 py-3 border-b border-zinc-800 flex items-center justify-between">
        <h1 className="text-sm font-medium text-zinc-400">
          Interactive Novel Engine
        </h1>
        <div className="text-xs text-zinc-600">v2.0</div>
      </header>

      {/* Narrative area */}
      <NarrativeView />

      {/* Input area */}
      <InputPanel onSubmit={handlePlayerInput} />

      {/* Debug panel */}
      <DebugPanel />
    </div>
  );
}
