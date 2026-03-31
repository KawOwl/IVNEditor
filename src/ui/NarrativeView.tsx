/**
 * NarrativeView — 流式叙事显示组件
 *
 * 显示 LLM 生成的叙事和玩家输入的对话历史。
 * 支持流式打字机效果（显示正在生成的文本）。
 * 自动滚动到底部。
 */

import { useEffect, useRef } from 'react';
import { useGameStore } from '../stores/game-store';
import { cn } from '../lib/utils';

export function NarrativeView() {
  const entries = useGameStore((s) => s.entries);
  const streamingText = useGameStore((s) => s.streamingText);
  const isStreaming = useGameStore((s) => s.isStreaming);
  const status = useGameStore((s) => s.status);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, streamingText]);

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
        <NarrativeEntry key={entry.id} role={entry.role} content={entry.content} />
      ))}

      {/* Streaming text (currently generating) */}
      {isStreaming && streamingText && (
        <NarrativeEntry role="generate" content={streamingText} streaming />
      )}

      {/* Loading indicator */}
      {status === 'generating' && !streamingText && (
        <div className="text-zinc-500 animate-pulse">正在生成...</div>
      )}
    </div>
  );
}

// ============================================================================
// NarrativeEntry
// ============================================================================

function NarrativeEntry({
  role,
  content,
  streaming = false,
}: {
  role: 'generate' | 'receive' | 'system';
  content: string;
  streaming?: boolean;
}) {
  return (
    <div
      className={cn(
        'max-w-3xl',
        role === 'receive' && 'ml-auto text-right',
        role === 'system' && 'mx-auto text-center text-zinc-500 text-sm',
      )}
    >
      {role === 'receive' && (
        <div className="text-xs text-zinc-500 mb-1">你</div>
      )}
      <div
        className={cn(
          'whitespace-pre-wrap leading-relaxed',
          role === 'generate' && 'text-zinc-100 prose prose-invert prose-sm max-w-none',
          role === 'receive' && 'text-blue-200 bg-blue-950/30 rounded-lg px-4 py-2 inline-block text-left',
          role === 'system' && 'text-zinc-500 italic',
          streaming && 'animate-pulse',
        )}
      >
        {content}
        {streaming && <span className="inline-block w-0.5 h-4 bg-zinc-400 ml-0.5 animate-pulse" />}
      </div>
    </div>
  );
}
