/**
 * DebugPanel — 增强调试面板
 *
 * Step 4.4: 新增 changelog viewer、token 可视化条形图、记忆条目浏览。
 * 6 个 tab：state / tools / tokens / memory / changelog / segments
 */

import { useState } from 'react';
import { useGameStore } from '../stores/game-store';
import { cn } from '../lib/utils';

type DebugTab = 'state' | 'tools' | 'tokens' | 'memory' | 'changelog';

export function DebugPanel() {
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<DebugTab>('state');

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
            {(['state', 'tools', 'tokens', 'memory', 'changelog'] as const).map((tab) => (
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
          <div className="max-h-72 overflow-y-auto text-xs font-mono">
            {activeTab === 'state' && <StateTab />}
            {activeTab === 'tools' && <ToolsTab />}
            {activeTab === 'tokens' && <TokensTab />}
            {activeTab === 'memory' && <MemoryTab />}
            {activeTab === 'changelog' && <ChangelogTab />}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// State Tab
// ============================================================================

function StateTab() {
  const stateVars = useGameStore((s) => s.stateVars);
  const totalTurns = useGameStore((s) => s.totalTurns);

  return (
    <div className="space-y-1 text-zinc-400">
      <div className="text-zinc-500 mb-1">
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

// ============================================================================
// Tools Tab
// ============================================================================

function ToolsTab() {
  const toolCalls = useGameStore((s) => s.toolCalls);

  return (
    <div className="space-y-2 text-zinc-400">
      {toolCalls.length === 0 ? (
        <span className="text-zinc-600">No tool calls yet</span>
      ) : (
        [...toolCalls].reverse().slice(0, 30).map((tc, i) => (
          <div key={i} className="border-b border-zinc-800 pb-1">
            <div className="flex items-center gap-2">
              <span className="text-yellow-400">{tc.name}</span>
              <span className="text-zinc-600 text-[10px]">
                {new Date(tc.timestamp).toLocaleTimeString()}
              </span>
            </div>
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

// ============================================================================
// Tokens Tab (Enhanced with bar chart)
// ============================================================================

function TokensTab() {
  const breakdown = useGameStore((s) => s.tokenBreakdown);

  if (!breakdown) {
    return <span className="text-zinc-600">No token data yet</span>;
  }

  const items = [
    { label: 'System', value: breakdown.system, color: 'bg-purple-500' },
    { label: 'State', value: breakdown.state, color: 'bg-blue-500' },
    { label: 'Summaries', value: breakdown.summaries, color: 'bg-green-500' },
    { label: 'History', value: breakdown.recentHistory, color: 'bg-amber-500' },
    { label: 'Context', value: breakdown.contextSegments, color: 'bg-cyan-500' },
  ];

  const usagePercent = Math.round((breakdown.total / breakdown.budget) * 100);
  const maxValue = Math.max(...items.map((i) => i.value), 1);

  return (
    <div className="space-y-2 text-zinc-400">
      {/* Overall usage */}
      <div>
        <div className="flex justify-between mb-1">
          <span>Total: {breakdown.total.toLocaleString()} / {breakdown.budget.toLocaleString()}</span>
          <span className={cn(
            usagePercent > 90 ? 'text-red-400' : usagePercent > 70 ? 'text-yellow-400' : 'text-green-400',
          )}>
            {usagePercent}%
          </span>
        </div>
        <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
          <div
            className={cn(
              'h-full rounded-full transition-all',
              usagePercent > 90 ? 'bg-red-500' : usagePercent > 70 ? 'bg-yellow-500' : 'bg-green-500',
            )}
            style={{ width: `${Math.min(usagePercent, 100)}%` }}
          />
        </div>
      </div>

      {/* Per-category bar chart */}
      <div className="space-y-1.5 mt-2">
        {items.map((item) => {
          const pct = Math.round((item.value / maxValue) * 100);
          return (
            <div key={item.label}>
              <div className="flex justify-between text-[10px] mb-0.5">
                <span>{item.label}</span>
                <span className="text-zinc-300">{item.value.toLocaleString()}</span>
              </div>
              <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className={cn('h-full rounded-full transition-all', item.color)}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================================
// Memory Tab (Enhanced with entry browsing)
// ============================================================================

function MemoryTab() {
  const entryCount = useGameStore((s) => s.memoryEntryCount);
  const summaryCount = useGameStore((s) => s.memorySummaryCount);
  const entries = useGameStore((s) => s.memoryEntries);
  const summaries = useGameStore((s) => s.memorySummaries);
  const [showEntries, setShowEntries] = useState(false);

  return (
    <div className="space-y-2 text-zinc-400">
      <div className="flex gap-4">
        <span>Entries: <span className="text-zinc-300">{entryCount}</span></span>
        <span>Summaries: <span className="text-zinc-300">{summaryCount}</span></span>
      </div>

      {/* Summaries */}
      {summaries.length > 0 && (
        <div>
          <div className="text-zinc-500 mb-1">摘要</div>
          {summaries.map((s, i) => (
            <div key={i} className="text-zinc-400 bg-zinc-900 rounded px-2 py-1 mb-1 text-[11px] whitespace-pre-wrap">
              {s.slice(0, 200)}{s.length > 200 ? '...' : ''}
            </div>
          ))}
        </div>
      )}

      {/* Entry browser */}
      <button
        onClick={() => setShowEntries(!showEntries)}
        className="text-[10px] text-blue-400 hover:text-blue-300"
      >
        {showEntries ? '收起条目' : `展开 ${entries.length} 条记忆`}
      </button>

      {showEntries && (
        <div className="space-y-1">
          {entries.length === 0 ? (
            <span className="text-zinc-600">No entries</span>
          ) : (
            [...entries].reverse().slice(0, 20).map((entry, i) => (
              <div key={i} className={cn(
                'px-2 py-1 rounded text-[11px]',
                entry.pinned ? 'bg-yellow-950/30 border border-yellow-900/30' : 'bg-zinc-900',
              )}>
                <div className="flex items-center gap-1 mb-0.5">
                  <span className={cn(
                    entry.role === 'generate' ? 'text-purple-400' :
                    entry.role === 'receive' ? 'text-blue-400' : 'text-zinc-500',
                  )}>
                    {entry.role}
                  </span>
                  {entry.pinned && <span className="text-yellow-400 text-[9px]">pinned</span>}
                </div>
                <div className="text-zinc-400 whitespace-pre-wrap">
                  {entry.content.slice(0, 150)}{entry.content.length > 150 ? '...' : ''}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Changelog Tab (New)
// ============================================================================

function ChangelogTab() {
  const entries = useGameStore((s) => s.changelogEntries);

  return (
    <div className="space-y-1 text-zinc-400">
      {entries.length === 0 ? (
        <span className="text-zinc-600">No changelog entries</span>
      ) : (
        <div>
          <div className="text-zinc-500 mb-1">
            {entries.length} 条状态变更记录
          </div>
          {[...entries].reverse().slice(0, 50).map((entry, i) => (
            <div key={i} className="flex items-start gap-2 py-1 border-b border-zinc-800/50">
              <span className="text-zinc-600 flex-none w-6 text-right">T{entry.turn}</span>
              <div className="flex-1 min-w-0">
                <span className="text-blue-400">{entry.key}</span>
                <span className="text-zinc-600 mx-1">:</span>
                <span className="text-red-400/70">{formatValue(entry.oldValue)}</span>
                <span className="text-zinc-600 mx-1">→</span>
                <span className="text-green-400">{formatValue(entry.newValue)}</span>
                <span className="text-zinc-600 text-[10px] ml-1">({entry.source})</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
