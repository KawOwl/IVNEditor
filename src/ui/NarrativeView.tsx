/**
 * NarrativeView — 流式叙事显示组件
 *
 * 显示 LLM 生成的叙事和玩家输入的对话历史。
 * 支持流式打字机效果（显示正在生成的文本）。
 * 自动滚动到底部。
 *
 * debug 模式下额外显示：
 *   - 可折叠的 Prompt 快照（该轮发给 LLM 的完整上下文）
 *   - Reasoning 文本
 *   - Tool Call / Result 记录
 *   - Finish Reason
 */

import { useState, useEffect, useRef } from 'react';
import { useGameStore } from '../stores/game-store';
import type { NarrativeEntry as NarrativeEntryType, ToolCallEntry, PromptSnapshot } from '../stores/game-store';
import { cn } from '../lib/utils';

interface NarrativeViewProps {
  showReasoning?: boolean;
}

export function NarrativeView({ showReasoning = false }: NarrativeViewProps) {
  const entries = useGameStore((s) => s.entries);
  const streamingText = useGameStore((s) => s.streamingText);
  const streamingReasoning = useGameStore((s) => s.streamingReasoning);
  const isStreaming = useGameStore((s) => s.isStreaming);
  const status = useGameStore((s) => s.status);
  const pendingToolCalls = useGameStore((s) => s.pendingToolCalls);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, streamingText, streamingReasoning]);

  return (
    <div
      ref={scrollRef}
      className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4"
    >
      {entries.length === 0 && !isStreaming && status === 'idle' && (
        <div className="text-zinc-500 text-center py-12">
          等待开始...
        </div>
      )}

      {entries.map((entry) => (
        <EntryBlock
          key={entry.id}
          entry={entry}
          debug={showReasoning}
        />
      ))}

      {/* Streaming entry (currently generating) */}
      {isStreaming && (streamingText || streamingReasoning || pendingToolCalls.length > 0) && (
        <StreamingBlock
          text={streamingText}
          reasoning={streamingReasoning}
          toolCalls={pendingToolCalls}
          debug={showReasoning}
        />
      )}

      {/* Loading indicator removed — status bar already shows "生成中..." */}
    </div>
  );
}

// ============================================================================
// EntryBlock — 一条完整的交互记录
// ============================================================================

function EntryBlock({
  entry,
  debug,
}: {
  entry: NarrativeEntryType;
  debug: boolean;
}) {
  if (entry.role === 'receive') {
    return (
      <div className="max-w-3xl ml-auto text-right">
        <div className="text-xs text-zinc-500 mb-1">你</div>
        <div className="text-blue-200 bg-blue-950/30 rounded-lg px-4 py-2 inline-block text-left whitespace-pre-wrap leading-relaxed">
          {entry.content}
        </div>
      </div>
    );
  }

  if (entry.role === 'system') {
    return (
      <div className="max-w-3xl mx-auto text-center">
        <div className="text-zinc-500 italic text-sm whitespace-pre-wrap leading-relaxed">
          {entry.content}
        </div>
      </div>
    );
  }

  // role === 'generate'
  return (
    <div className="max-w-3xl space-y-2">
      {/* Prompt snapshot (debug, collapsed by default) */}
      {debug && entry.promptSnapshot && (
        <PromptSnapshotBlock snapshot={entry.promptSnapshot} />
      )}

      {/* Reasoning (debug) */}
      {debug && entry.reasoning && (
        <CollapsibleBlock
          label="REASONING"
          borderClass="border-amber-900/40"
          bgClass="bg-amber-950/20"
          labelClass="text-amber-600"
        >
          <div className="text-xs text-amber-200/60 whitespace-pre-wrap font-mono leading-relaxed">
            {entry.reasoning}
          </div>
        </CollapsibleBlock>
      )}

      {/* Narrative text (always shown) */}
      <div className="text-zinc-100 prose prose-invert prose-sm max-w-none whitespace-pre-wrap leading-relaxed">
        {entry.content}
      </div>

      {/* Tool calls (debug) */}
      {debug && entry.toolCalls && entry.toolCalls.length > 0 && (
        <ToolCallsBlock calls={entry.toolCalls} />
      )}

      {/* Finish reason (debug) */}
      {debug && entry.finishReason && (
        <div className="text-[10px] font-mono text-zinc-600">
          finish: {entry.finishReason}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// StreamingBlock — 正在生成中的内容
// ============================================================================

function StreamingBlock({
  text,
  reasoning,
  toolCalls,
  debug,
}: {
  text: string;
  reasoning: string;
  toolCalls: ToolCallEntry[];
  debug: boolean;
}) {
  return (
    <div className="max-w-3xl space-y-2">
      {/* Reasoning (debug, streaming) */}
      {debug && reasoning && (
        <div className="px-3 py-2 rounded border border-amber-900/40 bg-amber-950/20">
          <div className="text-[10px] font-mono text-amber-600 mb-1 select-none">REASONING</div>
          <div className="text-xs text-amber-200/60 whitespace-pre-wrap font-mono leading-relaxed">
            {reasoning}
          </div>
        </div>
      )}

      {/* Text (streaming) */}
      {text && (
        <div className="text-zinc-100 prose prose-invert prose-sm max-w-none whitespace-pre-wrap leading-relaxed">
          {text}
          <span className="inline-block w-0.5 h-4 bg-zinc-400 ml-0.5 animate-pulse" />
        </div>
      )}

      {/* Tool calls so far (debug, streaming) */}
      {debug && toolCalls.length > 0 && (
        <ToolCallsBlock calls={toolCalls} />
      )}
    </div>
  );
}

// ============================================================================
// PromptSnapshotBlock — 可折叠的 Prompt 快照
// ============================================================================

function PromptSnapshotBlock({ snapshot }: { snapshot: PromptSnapshot }) {
  const [open, setOpen] = useState(false);
  const { tokenBreakdown, messages, activeSegmentIds } = snapshot;
  const msgCount = messages.length;

  return (
    <div className="border border-zinc-800 rounded text-[11px]">
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-zinc-900/50 transition-colors"
      >
        <span className="text-zinc-600">{open ? '▾' : '▸'}</span>
        <span className="text-zinc-400 font-mono">
          Prompt
        </span>
        <span className="text-zinc-600 font-mono">
          system: ~{tokenBreakdown.system.toLocaleString()} tok
        </span>
        <span className="text-zinc-700">|</span>
        <span className="text-zinc-600 font-mono">
          {msgCount} msg{msgCount !== 1 ? 's' : ''}
        </span>
        <span className="text-zinc-700">|</span>
        <span className="text-zinc-600 font-mono">
          {activeSegmentIds.length} seg
        </span>
        <span className="flex-1" />
        <span className={cn(
          'font-mono',
          tokenBreakdown.total / tokenBreakdown.budget > 0.8 ? 'text-amber-500' : 'text-zinc-600',
        )}>
          {tokenBreakdown.total.toLocaleString()} / {tokenBreakdown.budget.toLocaleString()} tok
        </span>
      </button>

      {open && (
        <div className="border-t border-zinc-800 max-h-80 overflow-y-auto">
          {/* Token breakdown */}
          <div className="px-3 py-2 border-b border-zinc-800/50 flex gap-4 text-[10px] text-zinc-500 font-mono">
            <span>system: <span className="text-purple-400">{tokenBreakdown.system}</span></span>
            <span>state: <span className="text-blue-400">{tokenBreakdown.state}</span></span>
            <span>summary: <span className="text-green-400">{tokenBreakdown.summaries}</span></span>
            <span>history: <span className="text-amber-400">{tokenBreakdown.recentHistory}</span></span>
            <span>context: <span className="text-cyan-400">{tokenBreakdown.contextSegments}</span></span>
          </div>

          {/* System prompt (split by ---) */}
          <div className="px-3 py-2 border-b border-zinc-800/50">
            <div className="text-[10px] text-zinc-500 font-mono mb-1">SYSTEM PROMPT</div>
            <pre className="text-[10px] text-zinc-400 whitespace-pre-wrap font-mono leading-relaxed max-h-48 overflow-y-auto">
              {snapshot.systemPrompt.length > 4000
                ? snapshot.systemPrompt.slice(0, 4000) + '\n\n... (' + snapshot.systemPrompt.length.toLocaleString() + ' chars total)'
                : snapshot.systemPrompt}
            </pre>
          </div>

          {/* Messages */}
          <div className="px-3 py-2">
            <div className="text-[10px] text-zinc-500 font-mono mb-1">MESSAGES ({messages.length})</div>
            <div className="space-y-1.5">
              {messages.map((msg, i) => (
                <div key={i} className="flex gap-2">
                  <span className={cn(
                    'flex-none text-[10px] font-mono px-1 py-0.5 rounded',
                    msg.role === 'user' ? 'bg-blue-950 text-blue-400' :
                    msg.role === 'assistant' ? 'bg-purple-950 text-purple-400' :
                    'bg-zinc-800 text-zinc-400',
                  )}>
                    {msg.role}
                  </span>
                  <pre className="flex-1 text-[10px] text-zinc-400 whitespace-pre-wrap font-mono leading-relaxed truncate max-h-20 overflow-hidden">
                    {msg.content.length > 500
                      ? msg.content.slice(0, 500) + '...'
                      : msg.content}
                  </pre>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// ToolCallsBlock — Tool Call 记录
// ============================================================================

function ToolCallsBlock({ calls }: { calls: ToolCallEntry[] }) {
  return (
    <div className="space-y-1">
      {calls.map((tc, i) => (
        <div key={i} className="flex items-start gap-2 text-[11px] font-mono">
          <span className="flex-none text-yellow-600 select-none">tool</span>
          <div className="flex-1 min-w-0">
            <span className="text-yellow-400">{tc.name}</span>
            <span className="text-zinc-600">(</span>
            <span className="text-zinc-400">
              {formatArgs(tc.args)}
            </span>
            <span className="text-zinc-600">)</span>
            {tc.result !== undefined && (
              <div className="text-zinc-500 truncate">
                → {formatResult(tc.result)}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// CollapsibleBlock — 通用可折叠区域
// ============================================================================

function CollapsibleBlock({
  label,
  borderClass,
  bgClass,
  labelClass,
  children,
  defaultOpen = false,
}: {
  label: string;
  borderClass: string;
  bgClass: string;
  labelClass: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className={cn('rounded border', borderClass, bgClass)}>
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-3 py-1.5 text-left flex items-center gap-2"
      >
        <span className="text-zinc-600 text-[10px]">{open ? '▾' : '▸'}</span>
        <span className={cn('text-[10px] font-mono select-none', labelClass)}>
          {label}
        </span>
      </button>
      {open && (
        <div className="px-3 pb-2">
          {children}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Helpers
// ============================================================================

function formatArgs(args: unknown): string {
  if (args === undefined || args === null) return '';
  try {
    const str = JSON.stringify(args);
    return str.length > 120 ? str.slice(0, 120) + '...' : str;
  } catch {
    return String(args);
  }
}

function formatResult(result: unknown): string {
  if (result === undefined || result === null) return 'null';
  try {
    const str = JSON.stringify(result);
    return str.length > 100 ? str.slice(0, 100) + '...' : str;
  } catch {
    return String(result);
  }
}
