/**
 * NarrativeView — 统一叙事显示组件
 *
 * 所有内容（流式 + 已完成）都在 entries[] 中。
 * generate entry 使用打字机效果"追赶"内容缓冲区：
 *   - streaming=true 时，content 持续增长，typewriter 按 CPS 追赶
 *   - streaming=false 后，typewriter 继续追完剩余文字
 *
 * debug 模式下额外显示：
 *   - 可折叠的 Prompt 快照
 *   - Reasoning 文本
 *   - Tool Call / Result 记录
 *   - Finish Reason
 */

import { useState, useEffect, useRef } from 'react';
import { useGameStore } from '../stores/game-store';
import type { NarrativeEntry as NarrativeEntryType, ToolCallEntry, PromptSnapshot } from '../stores/game-store';
import { cn } from '../lib/utils';

// ============================================================================
// 打字机速度设置（localStorage 持久化）
// ============================================================================

const LS_TYPEWRITER_KEY = 'ivn-typewriter-speed';

/** 每秒最大字符数。0 = 无限速（即时显示） */
export function getTypewriterSpeed(): number {
  const raw = localStorage.getItem(LS_TYPEWRITER_KEY);
  if (raw) {
    const n = Number(raw);
    if (!isNaN(n) && n >= 0) return n;
  }
  return 60; // 默认每秒 60 字
}

export function setTypewriterSpeed(cps: number): void {
  localStorage.setItem(LS_TYPEWRITER_KEY, String(Math.max(0, Math.round(cps))));
}

// ============================================================================
// useTypewriter — 打字机"追赶"hook
// ============================================================================

/**
 * 接收持续增长的文本缓冲区，返回按 CPS 逐步"追赶"的显示文本。
 * - buffer 增长时，typewriter 匀速追赶
 * - typewriter 追上 buffer 后停下等待新 chunk
 * - cps = 0 时直接返回原文（无节流）
 */
function useTypewriter(fullText: string, cps: number): string {
  const [visibleLen, setVisibleLen] = useState(0);
  const rafRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);

  // fullText 缩短时（新 entry / reset），同步重置
  useEffect(() => {
    if (fullText.length < visibleLen) {
      setVisibleLen(fullText.length);
    }
  }, [fullText, visibleLen]);

  useEffect(() => {
    if (cps <= 0) {
      setVisibleLen(fullText.length);
      return;
    }

    const msPerChar = 1000 / cps;

    const tick = (now: number) => {
      if (!lastTimeRef.current) lastTimeRef.current = now;
      const elapsed = now - lastTimeRef.current;
      const charsToAdd = Math.floor(elapsed / msPerChar);

      if (charsToAdd > 0) {
        lastTimeRef.current += charsToAdd * msPerChar;
        setVisibleLen((prev) => Math.min(prev + charsToAdd, fullText.length));
      }

      // 还没追上 → 继续
      setVisibleLen((prev) => {
        if (prev < fullText.length) {
          rafRef.current = requestAnimationFrame(tick);
        }
        return prev;
      });
    };

    // 还没追上 → 启动/重启动画
    if (visibleLen < fullText.length) {
      if (!lastTimeRef.current) lastTimeRef.current = performance.now();
      rafRef.current = requestAnimationFrame(tick);
    }

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      // 重置时间戳，避免下次 fullText 增长后因为间隔太长而一次性追赶大量字符
      lastTimeRef.current = 0;
    };
  }, [fullText, cps, visibleLen]);

  if (cps <= 0) return fullText;
  return fullText.slice(0, visibleLen);
}

// ============================================================================
// NarrativeView
// ============================================================================

interface NarrativeViewProps {
  showReasoning?: boolean;
}

export function NarrativeView({ showReasoning = false }: NarrativeViewProps) {
  const entries = useGameStore((s) => s.entries);
  const status = useGameStore((s) => s.status);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const entryRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Auto-scroll: ResizeObserver 监听内容高度变化（覆盖打字机动画期间）
  const prevScrollHeightRef = useRef(0);
  useEffect(() => {
    const scrollEl = scrollRef.current;
    const contentEl = contentRef.current;
    if (!scrollEl || !contentEl) return;

    prevScrollHeightRef.current = scrollEl.scrollHeight;

    const observer = new ResizeObserver(() => {
      const wasAtBottom =
        prevScrollHeightRef.current - scrollEl.scrollTop - scrollEl.clientHeight < 60;
      prevScrollHeightRef.current = scrollEl.scrollHeight;
      if (wasAtBottom) {
        scrollEl.scrollTop = scrollEl.scrollHeight;
      }
    });
    observer.observe(contentEl);
    return () => observer.disconnect();
  }, []);

  const scrollToEntry = (id: string) => {
    const el = entryRefs.current.get(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={scrollRef}
        className="h-full overflow-y-auto px-6 py-4"
      >
        <div ref={contentRef} className="space-y-4">
          {entries.length === 0 && status === 'idle' && (
            <div className="text-zinc-500 text-center py-12">
              等待开始...
            </div>
          )}

          {entries.map((entry) => (
            <div
              key={entry.id}
              ref={(el) => { if (el) entryRefs.current.set(entry.id, el); }}
            >
              <EntryBlock entry={entry} debug={showReasoning} />
            </div>
          ))}
        </div>
      </div>

      {/* Conversation minimap */}
      {entries.length > 1 && (
        <ConversationMinimap entries={entries} onScrollTo={scrollToEntry} />
      )}
    </div>
  );
}

// ============================================================================
// ConversationMinimap
// ============================================================================

function ConversationMinimap({
  entries,
  onScrollTo,
}: {
  entries: NarrativeEntryType[];
  onScrollTo: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!expanded) return;
    const handler = (e: MouseEvent | TouchEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setExpanded(false);
      }
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, [expanded]);

  const items = entries.filter((e) => e.content.trim().length > 0);
  if (items.length === 0) return null;

  return (
    <div
      ref={panelRef}
      className="absolute right-0 top-0 bottom-0 z-20 flex flex-col items-end"
    >
      {!expanded && (
        <div
          className="flex flex-col justify-center gap-1.5 py-4 px-1 w-5 h-full cursor-pointer"
          onClick={() => setExpanded(true)}
        >
          {items.map((entry) => (
            <span
              key={entry.id}
              className={cn(
                'block w-3 h-[2px] rounded-full ml-auto',
                entry.role === 'receive'
                  ? 'bg-blue-400/70'
                  : entry.role === 'system'
                  ? 'bg-zinc-600'
                  : 'bg-zinc-500/40',
              )}
            />
          ))}
        </div>
      )}

      {expanded && (
        <div className="w-52 max-h-full overflow-y-auto bg-zinc-900/95 backdrop-blur-sm rounded-l-lg border-l border-zinc-700/50 py-2 shadow-xl">
          <div className="px-3 pb-1.5 text-[9px] text-zinc-600 uppercase tracking-wider">
            对话目录
          </div>
          {items.map((entry, i) => (
            <button
              key={entry.id}
              onClick={() => { onScrollTo(entry.id); setExpanded(false); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-800/60 active:bg-zinc-800 transition-colors"
            >
              <span className={cn(
                'flex-none w-1.5 h-1.5 rounded-full',
                entry.role === 'receive'
                  ? 'bg-blue-400'
                  : entry.role === 'system'
                  ? 'bg-zinc-600'
                  : 'bg-zinc-500',
              )} />
              <span className="flex-none text-[9px] text-zinc-600 font-mono w-3">
                {i + 1}
              </span>
              <span className={cn(
                'flex-1 text-[10px] truncate leading-tight',
                entry.role === 'receive' ? 'text-blue-300' : 'text-zinc-400',
              )}>
                {entry.role === 'receive' ? '你: ' : ''}
                {entry.content.slice(0, 30)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// EntryBlock — 一条交互记录（统一组件）
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
        <div className="text-blue-200 bg-blue-950/30 rounded px-4 py-2 inline-block text-left whitespace-pre-wrap leading-relaxed">
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

  // role === 'generate' → 打字机追赶
  return <GenerateBlock entry={entry} debug={debug} />;
}

// ============================================================================
// GenerateBlock — LLM 输出（流式 + 打字机统一）
// ============================================================================

function GenerateBlock({
  entry,
  debug,
}: {
  entry: NarrativeEntryType;
  debug: boolean;
}) {
  const [cps] = useState(() => getTypewriterSpeed());
  const displayText = useTypewriter(entry.content, cps);

  // 打字机还在追赶 或 LLM 还在流式输出 → 显示光标
  const isPlaying = displayText.length < entry.content.length || !!entry.streaming;

  return (
    <div className="max-w-3xl space-y-2">
      {/* Prompt snapshot (debug) */}
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

      {/* 叙事文本 — typewriter 追赶缓冲区 */}
      {(displayText || entry.streaming) ? (
        <div className="text-zinc-100 prose prose-invert prose-sm max-w-none whitespace-pre-wrap leading-relaxed">
          {displayText}
          {isPlaying && (
            <span className="inline-block w-0.5 h-4 bg-zinc-400 ml-0.5 animate-pulse" />
          )}
        </div>
      ) : null}

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
// PromptSnapshotBlock
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
        <span className="text-zinc-400 font-mono">Prompt</span>
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
          <div className="px-3 py-2 border-b border-zinc-800/50 flex gap-4 text-[10px] text-zinc-500 font-mono">
            <span>system: <span className="text-purple-400">{tokenBreakdown.system}</span></span>
            <span>state: <span className="text-blue-400">{tokenBreakdown.state}</span></span>
            <span>summary: <span className="text-green-400">{tokenBreakdown.summaries}</span></span>
            <span>history: <span className="text-amber-400">{tokenBreakdown.recentHistory}</span></span>
            <span>context: <span className="text-cyan-400">{tokenBreakdown.contextSegments}</span></span>
          </div>

          <div className="px-3 py-2 border-b border-zinc-800/50">
            <div className="text-[10px] text-zinc-500 font-mono mb-1">SYSTEM PROMPT</div>
            <pre className="text-[10px] text-zinc-400 whitespace-pre-wrap font-mono leading-relaxed max-h-48 overflow-y-auto">
              {snapshot.systemPrompt.length > 4000
                ? snapshot.systemPrompt.slice(0, 4000) + '\n\n... (' + snapshot.systemPrompt.length.toLocaleString() + ' chars total)'
                : snapshot.systemPrompt}
            </pre>
          </div>

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
// ToolCallsBlock
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
            <span className="text-zinc-400">{formatArgs(tc.args)}</span>
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
// CollapsibleBlock
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
