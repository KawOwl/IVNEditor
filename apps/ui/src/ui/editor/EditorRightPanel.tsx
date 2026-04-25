import { EditorDebugPanel } from '#internal/ui/editor/EditorDebugPanel';
import { EditorPlayTab } from '#internal/ui/editor/EditorPlayTab';
import { PromptPreviewPanel } from '#internal/ui/editor/PromptPreviewPanel';
import { ScriptInfoPanel } from '#internal/ui/editor/ScriptInfoPanel';
import { LLMSettingsPanel } from '#internal/ui/settings/LLMSettingsPanel';
import { cn } from '@/lib/utils';
import type {
  BackgroundAsset,
  CharacterAsset,
  MemoryConfig,
  ProtocolVersion,
  PromptSegment,
  SceneState,
  ScriptManifest,
  StateSchema,
} from '@ivn/core/types';
import type { LLMConfigEntry } from '@/stores/llm-configs-store';

export type RightTab = 'prompt' | 'play' | 'debug' | 'settings' | 'info';

export interface EditorRightPanelProps {
  activeTab: RightTab;
  onTabChange: (tab: RightTab) => void;
  segments: PromptSegment[];
  stateSchema: StateSchema;
  memoryConfig: MemoryConfig;
  enabledTools: string[];
  initialPrompt: string;
  promptAssemblyOrder?: string[];
  disabledAssemblySections: string[];
  playManifest: ScriptManifest;
  loadedScriptId: string | null;
  loadedVersionId: string | null;
  scriptLabel: string;
  scriptDescription: string;
  scriptTags: string[];
  productionLlmConfigId: string | null;
  protocolVersion: ProtocolVersion;
  playtestLlmConfigId: string | null;
  llmConfigs: LLMConfigEntry[];
  characters: CharacterAsset[];
  backgrounds: BackgroundAsset[];
  defaultScene?: SceneState;
  onPromptAssemblyOrderChange: (order: string[]) => void;
  onDisabledAssemblySectionsChange: (disabled: string[]) => void;
  onPlaytestLlmConfigIdChange: (id: string | null) => void;
  onLabelChange: (label: string) => void;
  onDescriptionChange: (description: string) => void;
  onTagsChange: (tags: string[]) => void;
  onStateSchemaChange: (schema: StateSchema) => void;
  onMemoryConfigChange: (config: MemoryConfig) => void;
  onEnabledToolsChange: (tools: string[]) => void;
  onInitialPromptChange: (prompt: string) => void;
  onProductionLlmConfigIdChange: (id: string | null) => void;
  onProtocolVersionChange: (version: ProtocolVersion) => void;
  onCharactersChange: (characters: CharacterAsset[]) => void;
  onBackgroundsChange: (backgrounds: BackgroundAsset[]) => void;
  onDefaultSceneChange: (scene: SceneState | undefined) => void;
}

const tabs: Array<{
  id: RightTab;
  label: string;
  activeClass: string;
}> = [
  { id: 'prompt', label: 'Prompt 预览', activeClass: 'text-zinc-200 border-b-2 border-zinc-400' },
  { id: 'play', label: '试玩', activeClass: 'text-emerald-400 border-b-2 border-emerald-500' },
  { id: 'debug', label: '调试', activeClass: 'text-amber-400 border-b-2 border-amber-500' },
  { id: 'info', label: '剧本信息', activeClass: 'text-blue-400 border-b-2 border-blue-500' },
  { id: 'settings', label: '设置', activeClass: 'text-zinc-200 border-b-2 border-zinc-400' },
];

export function EditorRightPanel({
  activeTab,
  onTabChange,
  segments,
  stateSchema,
  memoryConfig,
  enabledTools,
  initialPrompt,
  promptAssemblyOrder,
  disabledAssemblySections,
  playManifest,
  loadedScriptId,
  loadedVersionId,
  scriptLabel,
  scriptDescription,
  scriptTags,
  productionLlmConfigId,
  protocolVersion,
  playtestLlmConfigId,
  llmConfigs,
  characters,
  backgrounds,
  defaultScene,
  onPromptAssemblyOrderChange,
  onDisabledAssemblySectionsChange,
  onPlaytestLlmConfigIdChange,
  onLabelChange,
  onDescriptionChange,
  onTagsChange,
  onStateSchemaChange,
  onMemoryConfigChange,
  onEnabledToolsChange,
  onInitialPromptChange,
  onProductionLlmConfigIdChange,
  onProtocolVersionChange,
  onCharactersChange,
  onBackgroundsChange,
  onDefaultSceneChange,
}: EditorRightPanelProps) {
  return (
    <div className="w-[420px] flex-none flex flex-col min-h-0 bg-zinc-950 border-l border-zinc-800">
      <div className="flex-none flex border-b border-zinc-800">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            className={cn(
              'flex-1 px-3 py-2 text-xs font-medium transition-colors',
              activeTab === tab.id ? tab.activeClass : 'text-zinc-500 hover:text-zinc-400',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-hidden relative">
        <div className={cn('absolute inset-0', activeTab !== 'prompt' && 'hidden')}>
          <PromptPreviewPanel
            segments={segments}
            stateSchema={stateSchema}
            initialPrompt={initialPrompt}
            assemblyOrder={promptAssemblyOrder}
            onOrderChange={onPromptAssemblyOrderChange}
            disabledSections={disabledAssemblySections}
            onDisabledChange={onDisabledAssemblySectionsChange}
            protocolVersion={protocolVersion}
            characters={characters}
            backgrounds={backgrounds}
          />
        </div>

        <div className={cn('absolute inset-0', activeTab !== 'play' && 'hidden')}>
          <EditorPlayTab
            manifest={playManifest}
            loadedScriptId={loadedScriptId}
            loadedVersionId={loadedVersionId}
            playtestLlmConfigId={playtestLlmConfigId}
            llmConfigs={llmConfigs}
            onPlaytestLlmConfigIdChange={onPlaytestLlmConfigIdChange}
          />
        </div>

        <div className={cn('absolute inset-0', activeTab !== 'debug' && 'hidden')}>
          <EditorDebugPanel />
        </div>

        <div className={cn('absolute inset-0', activeTab !== 'info' && 'hidden')}>
          <ScriptInfoPanel
            label={scriptLabel}
            description={scriptDescription}
            tags={scriptTags}
            stateSchema={stateSchema}
            memoryConfig={memoryConfig}
            enabledTools={enabledTools}
            initialPrompt={initialPrompt}
            productionLlmConfigId={productionLlmConfigId}
            protocolVersion={protocolVersion}
            characters={characters}
            backgrounds={backgrounds}
            defaultScene={defaultScene}
            loadedScriptId={loadedScriptId}
            onLabelChange={onLabelChange}
            onDescriptionChange={onDescriptionChange}
            onTagsChange={onTagsChange}
            onStateSchemaChange={onStateSchemaChange}
            onMemoryConfigChange={onMemoryConfigChange}
            onEnabledToolsChange={onEnabledToolsChange}
            onInitialPromptChange={onInitialPromptChange}
            onProductionLlmConfigIdChange={onProductionLlmConfigIdChange}
            onProtocolVersionChange={onProtocolVersionChange}
            onCharactersChange={onCharactersChange}
            onBackgroundsChange={onBackgroundsChange}
            onDefaultSceneChange={onDefaultSceneChange}
          />
        </div>

        <div className={cn('absolute inset-0 overflow-y-auto p-3', activeTab !== 'settings' && 'hidden')}>
          <LLMSettingsPanel />
        </div>
      </div>
    </div>
  );
}
