/**
 * EditorPlayTab — 编辑器右侧"试玩"tab 内容
 *
 * 镜像 PlayPage 的"列表 → 游戏"两阶段：
 *   1. 默认显示该剧本所有 kind=playtest 的 playthrough 列表
 *      （用 PlaythroughList 组件，kind='playtest' 过滤）
 *   2. 选中一条 → 渲染 PlayPanel + autoStart 恢复该 playthrough；
 *      点 "+ 开始新游戏" → 渲染 PlayPanel + autoStart 创建新试玩
 *
 * 顶部 header 始终显示"试玩使用 LLM"dropdown（控制下一次 NEW
 * playthrough 用哪套配置；恢复老 playthrough 时已经固化了，dropdown
 * 不影响那一局）；进入 game 视图时额外显示"← 返回列表"按钮。
 *
 * scriptId 没有（新建未保存的剧本）时不展示列表，给一段引导文案。
 */

import { useCallback, useState } from 'react';
import { PlayPanel } from '#internal/ui/play/PlayPanel';
import { PlaythroughList } from '#internal/ui/play/PlaythroughList';
import { useGameStore } from '@/stores/game-store';
import type { LLMConfigEntry } from '@/stores/llm-configs-store';
import type { ScriptManifest } from '@ivn/core/types';

export interface EditorPlayTabProps {
  manifest: ScriptManifest;
  loadedScriptId: string | null;
  loadedVersionId: string | null;
  playtestLlmConfigId: string | null;
  llmConfigs: LLMConfigEntry[];
  onPlaytestLlmConfigIdChange: (id: string | null) => void;
}

export function EditorPlayTab({
  manifest,
  loadedScriptId,
  loadedVersionId,
  playtestLlmConfigId,
  llmConfigs,
  onPlaytestLlmConfigIdChange,
}: EditorPlayTabProps) {
  const [selection, setSelection] = useState<string | 'new' | null>(null);

  const handleSelect = useCallback((id: string | 'new') => {
    useGameStore.getState().reset();
    setSelection(id);
  }, []);

  const handleBackToList = useCallback(() => {
    useGameStore.getState().reset();
    setSelection(null);
  }, []);

  const inGame = selection !== null;

  return (
    <div className="flex flex-col h-full">
      <div className="flex-none flex items-center gap-2 px-3 py-1.5 border-b border-zinc-800 bg-zinc-950/60">
        {inGame && (
          <button
            onClick={handleBackToList}
            className="text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            ← 返回列表
          </button>
        )}
        <span className="text-[10px] text-zinc-500">试玩使用：</span>
        <select
          value={playtestLlmConfigId ?? ''}
          onChange={(e) => onPlaytestLlmConfigIdChange(e.target.value || null)}
          className="flex-1 text-[11px] px-2 py-0.5 bg-zinc-900 border border-zinc-700 rounded text-zinc-300 focus:outline-none focus:border-zinc-500"
        >
          <option value="">（剧本默认 / fallback）</option>
          {llmConfigs.map((config) => (
            <option key={config.id} value={config.id}>
              {config.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex-1 min-h-0">
        {inGame ? (
          <PlayPanel
            key={selection ?? 'new'}
            manifest={manifest}
            playthroughId={selection ?? undefined}
            compact
            showDebug={false}
            showReasoning
            editorMode
            scriptVersionId={loadedVersionId ?? undefined}
            llmConfigId={playtestLlmConfigId}
            autoStart
          />
        ) : loadedScriptId ? (
          <PlaythroughList
            scriptId={loadedScriptId}
            scriptTitle={manifest.label}
            kind="playtest"
            onSelect={handleSelect}
          />
        ) : (
          <div className="h-full flex items-center justify-center px-6 text-center text-xs text-zinc-500">
            保存剧本后即可创建 / 查看试玩存档。
          </div>
        )}
      </div>
    </div>
  );
}
