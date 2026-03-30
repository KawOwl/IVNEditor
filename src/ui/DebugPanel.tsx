/**
 * DebugPanel — 调试面板
 *
 * 显示引擎内部状态：
 *   - ScriptState 变量
 *   - 当前节点/阶段
 *   - Token 预算分配
 *   - 工具调用记录
 *   - 记忆统计
 *
 * 可折叠，默认折叠状态。
 */

import { useState } from 'react';
import { useGameStore } from '../stores/game-store';
import { cn } from '../lib/utils';

export function DebugPanel() {
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'state' | 'tools' | 'tokens' | 'memory'>('state');

  return (
    <div className="border-t border-zinc-800">
      {/* Toggle bar */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full px-4 py-1.5 text-xs text-zinc-500 hover:text-zinc-400 flex items-center gap-2 transition-colors"
      >
        <span className={cn('transition-transform', isOpen && 'rotate-90')}>
          &#9654;
        </span>
        Debug
      </button>

      {isOpen && (
        <div className="px-4 pb-3">
          {/* Tabs */}
          <div className="flex gap-1 mb-2">
            {(['state', 'tools', 'tokens', 'memory'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={cn(
                  'px-2 py-1 text-xs rounded transition-colors',
                  activeTab === tab
                    ? 'bg-zinc-700 text-zinc-200'
                    : 'text-zinc-500 hover:text-zinc-400',
                )}
              >
                {tab}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="max-h-60 overflow-y-auto text-xs font-mono">
            {activeTab === 'state' && <StateTab />}
            {activeTab === 'tools' && <ToolsTab />}
            {activeTab === 'tokens' && <TokensTab />}
            {activeTab === 'memory' && <MemoryTab />}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Tabs
// ============================================================================

function StateTab() {
  const stateVars = useGameStore((s) => s.stateVars);
  const currentNodeId = useGameStore((s) => s.currentNodeId);
  const currentNodePhase = useGameStore((s) => s.currentNodePhase);
  const totalTurns = useGameStore((s) => s.totalTurns);

  return (
    <div className="space-y-1 text-zinc-400">
      <div className="text-zinc-500 mb-1">
        Node: <span className="text-zinc-300">{currentNodeId ?? '—'}</span>{' '}
        Phase: <span className="text-zinc-300">{currentNodePhase ?? '—'}</span>{' '}
        Turns: <span className="text-zinc-300">{totalTurns}</span>
      </div>
      <div className="border-t border-zinc-800 pt-1">
        {Object.keys(stateVars).length === 0 ? (
          <span className="text-zinc-600">No state variables</span>
        ) : (
          Object.entries(stateVars).map(([key, value]) => (
            <div key={key}>
              <span className="text-blue-400">{key}</span>:{' '}
              <span className="text-zinc-300">
                {typeof value === 'object' ? JSON.stringify(value) : String(value)}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ToolsTab() {
  const toolCalls = useGameStore((s) => s.toolCalls);

  return (
    <div className="space-y-2 text-zinc-400">
      {toolCalls.length === 0 ? (
        <span className="text-zinc-600">No tool calls yet</span>
      ) : (
        [...toolCalls].reverse().slice(0, 20).map((tc, i) => (
          <div key={i} className="border-b border-zinc-800 pb-1">
            <div className="text-yellow-400">{tc.name}</div>
            <div className="text-zinc-500 truncate">
              args: {JSON.stringify(tc.args)}
            </div>
            <div className="text-zinc-500 truncate">
              result: {JSON.stringify(tc.result)}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function TokensTab() {
  const breakdown = useGameStore((s) => s.tokenBreakdown);

  if (!breakdown) {
    return <span className="text-zinc-600">No token data yet</span>;
  }

  const items = [
    { label: 'System', value: breakdown.system },
    { label: 'State', value: breakdown.state },
    { label: 'Summaries', value: breakdown.summaries },
    { label: 'History', value: breakdown.recentHistory },
    { label: 'Context', value: breakdown.contextSegments },
  ];

  const usagePercent = Math.round((breakdown.total / breakdown.budget) * 100);

  return (
    <div className="space-y-1 text-zinc-400">
      <div className="mb-2">
        <div className="flex justify-between mb-1">
          <span>Total: {breakdown.total.toLocaleString()} / {breakdown.budget.toLocaleString()}</span>
          <span className={cn(
            usagePercent > 90 ? 'text-red-400' : usagePercent > 70 ? 'text-yellow-400' : 'text-green-400',
          )}>
            {usagePercent}%
          </span>
        </div>
        {/* Progress bar */}
        <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
          <div
            className={cn(
              'h-full rounded-full transition-all',
              usagePercent > 90 ? 'bg-red-500' : usagePercent > 70 ? 'bg-yellow-500' : 'bg-green-500',
            )}
            style={{ width: `${Math.min(usagePercent, 100)}%` }}
          />
        </div>
      </div>
      {items.map((item) => (
        <div key={item.label} className="flex justify-between">
          <span>{item.label}</span>
          <span className="text-zinc-300">{item.value.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

function MemoryTab() {
  const entryCount = useGameStore((s) => s.memoryEntryCount);
  const summaryCount = useGameStore((s) => s.memorySummaryCount);

  return (
    <div className="space-y-1 text-zinc-400">
      <div>Entries: <span className="text-zinc-300">{entryCount}</span></div>
      <div>Summaries: <span className="text-zinc-300">{summaryCount}</span></div>
    </div>
  );
}
