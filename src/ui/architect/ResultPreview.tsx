/**
 * ResultPreview — Agent 提取结果预览 + 确认 UI
 *
 * Step 2.8: 展示所有 Agent 提取结果，编剧确认或修改后导出 IR。
 * 分 tab 展示：状态变量、流程图、Prompt 片段、注入规则、工具配置、记忆策略。
 */

import { useState, useCallback } from 'react';
import { useArchitectStore } from '../../stores/architect-store';
import type { ArchitectResult } from '../../core/architect/types';
import type { ScriptManifest } from '../../core/types';
import { cn } from '../../lib/utils';

// ============================================================================
// Types
// ============================================================================

type PreviewTab = 'state' | 'flow' | 'segments' | 'rules' | 'tools' | 'memory';

export interface ResultPreviewProps {
  onConfirm: (manifest: ScriptManifest) => void;
  onBack: () => void;
}

// ============================================================================
// ResultPreview Component
// ============================================================================

export function ResultPreview({ onConfirm, onBack }: ResultPreviewProps) {
  const result = useArchitectStore((s) => s.result);
  const [activeTab, setActiveTab] = useState<PreviewTab>('state');

  const handleConfirm = useCallback(() => {
    if (!result) return;
    const manifest = buildManifest(result);
    onConfirm(manifest);
  }, [result, onConfirm]);

  if (!result) {
    return <div className="p-6 text-zinc-500">没有提取结果</div>;
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex-none px-6 py-4 border-b border-zinc-800">
        <h2 className="text-lg font-medium text-zinc-200">提取结果预览</h2>
        <p className="text-sm text-zinc-500 mt-1">检查并确认以下提取结果，确认后将生成剧本配置</p>
      </div>

      {/* Tabs */}
      <div className="flex-none px-6 pt-3 flex gap-1 border-b border-zinc-800">
        {([
          ['state', '状态变量'],
          ['flow', '流程图'],
          ['segments', 'Prompt 片段'],
          ['rules', '注入规则'],
          ['tools', '工具配置'],
          ['memory', '记忆策略'],
        ] as const).map(([tab, label]) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              'px-3 py-2 text-sm rounded-t transition-colors',
              activeTab === tab
                ? 'bg-zinc-800 text-zinc-200 border-b-2 border-blue-500'
                : 'text-zinc-500 hover:text-zinc-400',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {activeTab === 'state' && <StatePreview result={result} />}
        {activeTab === 'flow' && <FlowPreview result={result} />}
        {activeTab === 'segments' && <SegmentsPreview result={result} />}
        {activeTab === 'rules' && <RulesPreview result={result} />}
        {activeTab === 'tools' && <ToolsPreview result={result} />}
        {activeTab === 'memory' && <MemoryPreview result={result} />}
      </div>

      {/* Actions */}
      <div className="flex-none px-6 py-4 border-t border-zinc-800 flex gap-3">
        <button
          onClick={onBack}
          className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-300 transition-colors"
        >
          返回修改
        </button>
        <button
          onClick={handleConfirm}
          className="px-4 py-2 bg-green-600 text-white rounded text-sm hover:bg-green-500 transition-colors"
        >
          确认，生成剧本配置
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// Tab Components
// ============================================================================

function StatePreview({ result }: { result: ArchitectResult }) {
  const { schema, reasoning } = result.stateExtraction;
  return (
    <div className="space-y-3">
      <Reasoning text={reasoning} />
      <div className="space-y-2">
        {schema.variables.map((v) => (
          <div key={v.name} className="bg-zinc-900 rounded px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-mono text-blue-400">{v.name}</span>
              <span className="text-xs bg-zinc-800 px-1.5 py-0.5 rounded text-zinc-400">{v.type}</span>
            </div>
            <div className="text-xs text-zinc-500 mt-1">{v.description}</div>
            <div className="text-xs text-zinc-600 mt-0.5">初始值: {JSON.stringify(v.initial)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function FlowPreview({ result }: { result: ArchitectResult }) {
  const { graph, reasoning } = result.flowExtraction;
  return (
    <div className="space-y-3">
      <Reasoning text={reasoning} />
      <div className="space-y-2">
        <h4 className="text-sm text-zinc-400">节点 ({graph.nodes.length})</h4>
        {graph.nodes.map((n) => (
          <div key={n.id} className="bg-zinc-900 rounded px-4 py-2 flex items-center gap-3">
            <span className="text-sm text-zinc-200">{n.label}</span>
            <span className="text-xs text-zinc-600 font-mono">{n.id}</span>
            {n.description && <span className="text-xs text-zinc-500">{n.description}</span>}
          </div>
        ))}
        <h4 className="text-sm text-zinc-400 mt-4">边 ({graph.edges.length})</h4>
        {graph.edges.map((e, i) => (
          <div key={i} className="bg-zinc-900 rounded px-4 py-2 text-sm">
            <span className="text-zinc-300">{e.from}</span>
            <span className="text-zinc-600 mx-2">→</span>
            <span className="text-zinc-300">{e.to}</span>
            {e.label && (
              <span className="text-xs text-zinc-500 ml-2">{e.label}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function SegmentsPreview({ result }: { result: ArchitectResult }) {
  const { segments, reasoning } = result.promptSplit;
  return (
    <div className="space-y-3">
      <Reasoning text={reasoning} />
      <div className="space-y-2">
        {segments.map((s) => (
          <div key={s.id} className="bg-zinc-900 rounded px-4 py-3">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-sm text-zinc-200">{s.label}</span>
              <span className={cn(
                'text-xs px-1.5 py-0.5 rounded',
                s.type === 'logic' ? 'bg-yellow-900/50 text-yellow-300' : 'bg-zinc-800 text-zinc-400',
              )}>
                {s.type}
              </span>
              <span className="text-xs bg-zinc-800 px-1.5 py-0.5 rounded text-zinc-400">{s.role}</span>
              <span className="text-xs text-zinc-600">P{s.priority}</span>
            </div>
            <div className="text-xs text-zinc-500 line-clamp-3 whitespace-pre-wrap">
              {s.content.slice(0, 200)}{s.content.length > 200 ? '...' : ''}
            </div>
            <div className="text-xs text-zinc-600 mt-1">{s.tokenCount} tokens | {s.sourceDoc}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RulesPreview({ result }: { result: ArchitectResult }) {
  const { rules, reasoning } = result.injectionRules;
  return (
    <div className="space-y-3">
      <Reasoning text={reasoning} />
      <div className="space-y-2">
        {rules.map((r, i) => (
          <div key={i} className="bg-zinc-900 rounded px-4 py-3">
            <div className="text-sm text-zinc-200">{r.description}</div>
            <div className="text-xs text-yellow-400 font-mono mt-1">condition: {r.condition}</div>
          </div>
        ))}
        {rules.length === 0 && <div className="text-zinc-600 text-sm">未检测到注入规则</div>}
      </div>
    </div>
  );
}

function ToolsPreview({ result }: { result: ArchitectResult }) {
  const { enabledOptionalTools, reasoning } = result.toolEnablement;
  return (
    <div className="space-y-3">
      <Reasoning text={reasoning} />
      <div className="space-y-1">
        <div className="text-sm text-zinc-400 mb-2">必选工具（始终启用）</div>
        <div className="flex gap-2 mb-3">
          <ToolBadge name="update_state" enabled />
          <ToolBadge name="signal_input_needed" enabled />
        </div>
        <div className="text-sm text-zinc-400 mb-2">可选工具</div>
        <div className="flex flex-wrap gap-2">
          {['read_state', 'query_changelog', 'pin_memory', 'query_memory',
            'inject_context', 'list_context', 'set_mood',
            'change_scene', 'change_sprite', 'clear_stage',
          ].map((name) => (
            <ToolBadge key={name} name={name} enabled={enabledOptionalTools.includes(name)} />
          ))}
        </div>
      </div>
    </div>
  );
}

function MemoryPreview({ result }: { result: ArchitectResult }) {
  const { config, reasoning } = result.memoryStrategy;
  return (
    <div className="space-y-3">
      <Reasoning text={reasoning} />
      <div className="bg-zinc-900 rounded px-4 py-3 space-y-2 text-sm">
        <Row label="上下文预算" value={`${config.contextBudget.toLocaleString()} tokens`} />
        <Row label="压缩阈值" value={`${config.compressionThreshold.toLocaleString()} tokens`} />
        <Row label="保留最近" value={`${config.recencyWindow} 轮`} />
        {config.compressionHints && (
          <div>
            <div className="text-zinc-400 mb-1">压缩提示</div>
            <div className="text-zinc-300 text-xs whitespace-pre-wrap">{config.compressionHints}</div>
          </div>
        )}
        {config.crossChapterInheritance && (
          <div>
            <div className="text-zinc-400 mb-1">跨章继承</div>
            <div className="text-xs text-green-400">
              继承: {config.crossChapterInheritance.inherit.join(', ') || '无'}
            </div>
            <div className="text-xs text-red-400">
              排除: {config.crossChapterInheritance.exclude.join(', ') || '无'}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Shared Components
// ============================================================================

function Reasoning({ text }: { text: string }) {
  return (
    <div className="text-xs text-zinc-500 bg-zinc-900/50 rounded px-3 py-2 italic">
      {text}
    </div>
  );
}

function ToolBadge({ name, enabled }: { name: string; enabled: boolean }) {
  return (
    <span className={cn(
      'text-xs px-2 py-1 rounded font-mono',
      enabled ? 'bg-green-900/50 text-green-300' : 'bg-zinc-800 text-zinc-600',
    )}>
      {name}
    </span>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-zinc-400">{label}</span>
      <span className="text-zinc-200">{value}</span>
    </div>
  );
}

// ============================================================================
// Build ScriptManifest from ArchitectResult
// ============================================================================

function buildManifest(result: ArchitectResult): ScriptManifest {
  // Attach injection rules to segments
  const segmentsWithRules = result.promptSplit.segments.map((seg) => {
    const rule = result.injectionRules.rules.find((r) =>
      // Simple heuristic: if the rule's description mentions this segment's label
      r.description.includes(seg.label),
    );
    return rule ? { ...seg, injectionRule: rule } : seg;
  });

  return {
    id: `script-${Date.now()}`,
    label: '未命名剧本',
    stateSchema: result.stateExtraction.schema,
    memoryConfig: result.memoryStrategy.config,
    enabledTools: result.toolEnablement.enabledOptionalTools,
    chapters: [
      {
        id: 'chapter-1',
        label: '第一章',
        flowGraph: result.flowExtraction.graph,
        segments: segmentsWithRules,
      },
    ],
  };
}
