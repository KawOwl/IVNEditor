/**
 * EditorDebugPanel — 编辑器试玩模式的详细调试面板
 *
 * 显示当前轮次的完整调试信息：
 *   - 组装后的 System Prompt（完整文本，可折叠）
 *   - Messages 列表（role + content）
 *   - 活跃 Segments
 *   - Token 分配
 *   - 状态变量
 *   - 工具调用记录
 *   - 记忆条目
 */

import { useState } from 'react';
import { useGameStore } from '../../stores/game-store';
import { useRawStreamingStore } from '../../stores/raw-streaming-store';
import { cn } from '../../lib/utils';
import type { SceneState } from '../../core/types';

type DebugSection = 'prompt' | 'messages' | 'tokens' | 'state' | 'tools' | 'memory' | 'sentences' | 'raw';

export function EditorDebugPanel() {
  const [activeSection, setActiveSection] = useState<DebugSection>('prompt');

  const sections: { id: DebugSection; label: string }[] = [
    { id: 'prompt', label: 'Prompt' },
    { id: 'messages', label: 'Messages' },
    { id: 'tokens', label: 'Tokens' },
    { id: 'state', label: 'State' },
    { id: 'tools', label: 'Tools' },
    { id: 'memory', label: 'Memory' },
    { id: 'sentences', label: 'Sentences' },
    { id: 'raw', label: 'Raw' },
  ];

  return (
    <div className="flex flex-col h-full text-xs">
      {/* Section tabs */}
      <div className="flex-none flex border-b border-zinc-800 overflow-x-auto">
        {sections.map((s) => (
          <button
            key={s.id}
            onClick={() => setActiveSection(s.id)}
            className={cn(
              'px-2 py-1.5 text-[10px] font-medium whitespace-nowrap transition-colors',
              activeSection === s.id
                ? 'text-zinc-200 border-b border-zinc-400'
                : 'text-zinc-600 hover:text-zinc-400',
            )}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Section content */}
      <div className="flex-1 min-h-0 overflow-y-auto p-2 font-mono">
        {activeSection === 'prompt' && <PromptSection />}
        {activeSection === 'messages' && <MessagesSection />}
        {activeSection === 'tokens' && <TokensSection />}
        {activeSection === 'state' && <StateSection />}
        {activeSection === 'tools' && <ToolsSection />}
        {activeSection === 'memory' && <MemorySection />}
        {activeSection === 'sentences' && <SentencesSection />}
        {activeSection === 'raw' && <RawStreamingSection />}
      </div>
    </div>
  );
}

// ============================================================================
// Prompt Section — 组装后的完整 System Prompt
// ============================================================================

function PromptSection() {
  const systemPrompt = useGameStore((s) => s.assembledSystemPrompt);
  const [expanded, setExpanded] = useState(true);

  if (!systemPrompt) {
    return <Empty>尚未生成 — 点击「开始」运行一轮</Empty>;
  }

  // Split by --- sections for better readability
  const sections = systemPrompt.split(/\n---\n/);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-zinc-400 text-[10px] uppercase tracking-wider">
          System Prompt ({systemPrompt.length.toLocaleString()} chars)
        </span>
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-[10px] text-blue-400 hover:text-blue-300"
        >
          {expanded ? '折叠' : '展开'}
        </button>
      </div>

      {expanded && (
        <div className="space-y-2">
          {sections.map((section, i) => (
            <PromptBlock key={i} content={section} index={i} />
          ))}
        </div>
      )}
    </div>
  );
}

function PromptBlock({ content, index }: { content: string; index: number }) {
  const [open, setOpen] = useState(index === 0); // First block open by default
  const preview = content.slice(0, 80).replace(/\n/g, ' ');
  const lines = content.split('\n').length;

  return (
    <div className="border border-zinc-800 rounded">
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-2 py-1 text-left flex items-center justify-between hover:bg-zinc-900/50 transition-colors"
      >
        <span className="text-zinc-400 truncate flex-1">
          <span className="text-zinc-600 mr-1">§{index + 1}</span>
          {preview}...
        </span>
        <span className="text-zinc-600 text-[9px] flex-none ml-2">
          {lines}L {open ? '▾' : '▸'}
        </span>
      </button>
      {open && (
        <pre className="px-2 py-1.5 text-[11px] text-zinc-300 whitespace-pre-wrap border-t border-zinc-800 bg-zinc-900/30 max-h-60 overflow-y-auto leading-relaxed">
          {content}
        </pre>
      )}
    </div>
  );
}

// ============================================================================
// Messages Section — LLM 收到的 messages 列表
// ============================================================================

function MessagesSection() {
  const messages = useGameStore((s) => s.assembledMessages);

  if (messages.length === 0) {
    return <Empty>尚未生成 — 点击「开始」运行一轮</Empty>;
  }

  return (
    <div className="space-y-2">
      <span className="text-zinc-400 text-[10px] uppercase tracking-wider">
        Messages ({messages.length})
      </span>
      {messages.map((msg, i) => (
        <div key={i} className="border border-zinc-800 rounded">
          <div className="px-2 py-1 border-b border-zinc-800 flex items-center gap-2">
            <span className={cn(
              'text-[10px] font-medium px-1.5 py-0.5 rounded',
              msg.role === 'user' ? 'bg-blue-950 text-blue-400' :
              msg.role === 'assistant' ? 'bg-purple-950 text-purple-400' :
              'bg-zinc-800 text-zinc-400',
            )}>
              {msg.role}
            </span>
            <span className="text-zinc-600 text-[9px]">
              {msg.content.length} chars
            </span>
          </div>
          <pre className="px-2 py-1.5 text-[11px] text-zinc-300 whitespace-pre-wrap max-h-40 overflow-y-auto leading-relaxed">
            {msg.content}
          </pre>
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// Tokens Section
// ============================================================================

function TokensSection() {
  const breakdown = useGameStore((s) => s.tokenBreakdown);
  const activeSegmentIds = useGameStore((s) => s.activeSegmentIds);

  if (!breakdown) {
    return <Empty>尚无 Token 数据</Empty>;
  }

  const items = [
    { label: 'System Segments', value: breakdown.system, color: 'text-purple-400' },
    { label: 'State YAML', value: breakdown.state, color: 'text-blue-400' },
    { label: 'Memory Summaries', value: breakdown.summaries, color: 'text-green-400' },
    { label: 'Recent History', value: breakdown.recentHistory, color: 'text-amber-400' },
    { label: 'Context Segments', value: breakdown.contextSegments, color: 'text-cyan-400' },
  ];

  const usagePercent = Math.round((breakdown.total / breakdown.budget) * 100);

  return (
    <div className="space-y-3">
      {/* Overall */}
      <div>
        <div className="flex justify-between text-zinc-400 mb-1">
          <span>Total</span>
          <span className={cn(
            usagePercent > 90 ? 'text-red-400' : usagePercent > 70 ? 'text-yellow-400' : 'text-green-400',
          )}>
            {breakdown.total.toLocaleString()} / {breakdown.budget.toLocaleString()} ({usagePercent}%)
          </span>
        </div>
        <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
          <div
            className={cn(
              'h-full rounded-full',
              usagePercent > 90 ? 'bg-red-500' : usagePercent > 70 ? 'bg-yellow-500' : 'bg-green-500',
            )}
            style={{ width: `${Math.min(usagePercent, 100)}%` }}
          />
        </div>
      </div>

      {/* Breakdown */}
      <div className="space-y-1">
        {items.map((item) => (
          <div key={item.label} className="flex justify-between text-zinc-500">
            <span>{item.label}</span>
            <span className={item.color}>{item.value.toLocaleString()}</span>
          </div>
        ))}
      </div>

      {/* Active segments */}
      {activeSegmentIds.length > 0 && (
        <div>
          <span className="text-zinc-400 text-[10px] uppercase tracking-wider">
            Active Segments ({activeSegmentIds.length})
          </span>
          <div className="mt-1 space-y-0.5">
            {activeSegmentIds.map((id) => (
              <div key={id} className="text-zinc-400 text-[11px]">{id}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// State Section
// ============================================================================

function StateSection() {
  const stateVars = useGameStore((s) => s.stateVars);
  const totalTurns = useGameStore((s) => s.totalTurns);
  const changelogEntries = useGameStore((s) => s.changelogEntries);

  return (
    <div className="space-y-3">
      <div className="text-zinc-500">
        Turn: <span className="text-zinc-300">{totalTurns}</span>
      </div>

      {/* Variables */}
      <div>
        <span className="text-zinc-400 text-[10px] uppercase tracking-wider">Variables</span>
        <div className="mt-1 space-y-0.5">
          {Object.keys(stateVars).length === 0 ? (
            <span className="text-zinc-600">无状态变量</span>
          ) : (
            Object.entries(stateVars).map(([key, value]) => (
              <div key={key} className="flex justify-between">
                <span className="text-blue-400">{key}</span>
                <span className="text-zinc-300">
                  {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Recent changelog */}
      {changelogEntries.length > 0 && (
        <div>
          <span className="text-zinc-400 text-[10px] uppercase tracking-wider">
            Changelog ({changelogEntries.length})
          </span>
          <div className="mt-1 space-y-0.5">
            {[...changelogEntries].reverse().slice(0, 20).map((entry, i) => (
              <div key={i} className="text-zinc-500">
                <span className="text-zinc-600">T{entry.turn}</span>{' '}
                <span className="text-blue-400">{entry.key}</span>:{' '}
                <span className="text-red-400/70">{formatValue(entry.oldValue)}</span>
                {' → '}
                <span className="text-green-400">{formatValue(entry.newValue)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Tools Section
// ============================================================================

function ToolsSection() {
  const toolCalls = useGameStore((s) => s.toolCalls);

  if (toolCalls.length === 0) {
    return <Empty>无工具调用记录</Empty>;
  }

  return (
    <div className="space-y-2">
      <span className="text-zinc-400 text-[10px] uppercase tracking-wider">
        Tool Calls ({toolCalls.length})
      </span>
      {[...toolCalls].reverse().slice(0, 30).map((tc, i) => (
        <div key={i} className="border border-zinc-800 rounded px-2 py-1">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-yellow-400">{tc.name}</span>
            <span className="text-zinc-600 text-[9px]">
              {new Date(tc.timestamp).toLocaleTimeString()}
            </span>
          </div>
          <div className="text-zinc-500">
            <div className="truncate">args: {JSON.stringify(tc.args)}</div>
            {tc.result !== undefined && (
              <div className="truncate">result: {JSON.stringify(tc.result)}</div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// Memory Section
// ============================================================================

function MemorySection() {
  const entryCount = useGameStore((s) => s.memoryEntryCount);
  const summaryCount = useGameStore((s) => s.memorySummaryCount);
  const entries = useGameStore((s) => s.memoryEntries);
  const summaries = useGameStore((s) => s.memorySummaries);

  return (
    <div className="space-y-3">
      <div className="flex gap-3 text-zinc-500">
        <span>Entries: <span className="text-zinc-300">{entryCount}</span></span>
        <span>Summaries: <span className="text-zinc-300">{summaryCount}</span></span>
      </div>

      {summaries.length > 0 && (
        <div>
          <span className="text-zinc-400 text-[10px] uppercase tracking-wider">Summaries</span>
          {summaries.map((s, i) => (
            <pre key={i} className="mt-1 text-zinc-400 bg-zinc-900 rounded px-2 py-1 whitespace-pre-wrap max-h-32 overflow-y-auto">
              {s}
            </pre>
          ))}
        </div>
      )}

      {entries.length > 0 && (
        <div>
          <span className="text-zinc-400 text-[10px] uppercase tracking-wider">
            Recent Entries ({entries.length})
          </span>
          <div className="mt-1 space-y-1">
            {[...entries].reverse().slice(0, 15).map((entry, i) => (
              <div key={i} className={cn(
                'px-2 py-1 rounded',
                entry.pinned ? 'bg-yellow-950/30 border border-yellow-900/30' : 'bg-zinc-900',
              )}>
                <span className={cn(
                  entry.role === 'generate' ? 'text-purple-400' :
                  entry.role === 'receive' ? 'text-blue-400' : 'text-zinc-500',
                )}>
                  {entry.role}
                </span>
                {entry.pinned && <span className="text-yellow-400 text-[9px] ml-1">pinned</span>}
                <div className="text-zinc-400 whitespace-pre-wrap mt-0.5">
                  {entry.content.slice(0, 200)}{entry.content.length > 200 ? '...' : ''}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Sentences Section (M3) — XML-lite parser 产出的结构化叙事
// ============================================================================

function SentencesSection() {
  const sentences = useGameStore((s) => s.parsedSentences);
  const currentScene = useGameStore((s) => s.currentScene);

  return (
    <div className="space-y-3">
      {/* 当前场景 */}
      <div className="border border-zinc-800 rounded p-2">
        <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
          Current Scene
        </div>
        <div className="text-[11px] text-zinc-300">
          <div>
            <span className="text-zinc-500">background:</span>{' '}
            <span className="text-emerald-400">
              {currentScene.background ?? 'null'}
            </span>
          </div>
          <div className="mt-1">
            <span className="text-zinc-500">sprites ({currentScene.sprites.length}):</span>{' '}
            {currentScene.sprites.length === 0 ? (
              <span className="text-zinc-600">—</span>
            ) : (
              <ul className="ml-3 mt-1 space-y-0.5">
                {currentScene.sprites.map((sp, i) => (
                  <li key={i} className="text-zinc-400">
                    <span className="text-blue-400">{sp.id}</span>
                    {' · '}
                    <span className="text-amber-400">{sp.emotion}</span>
                    {sp.position && (
                      <span className="text-zinc-600"> @ {sp.position}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      {/* Sentences 列表 */}
      <div>
        <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
          Parsed Sentences ({sentences.length})
        </div>
        {sentences.length === 0 ? (
          <Empty>尚未解析到任何 Sentence — LLM 输出需要带 XML-lite 格式</Empty>
        ) : (
          <div className="space-y-1.5">
            {sentences.map((s, i) => (
              <SentenceRow key={i} sentence={s} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SentenceRow({ sentence }: { sentence: import('../../stores/game-store').Sentence }) {
  if (sentence.kind === 'narration') {
    return (
      <div className="border-l-2 border-zinc-700 pl-2 py-0.5">
        <div className="text-[9px] text-zinc-600">
          #{sentence.index} · narration · turn {sentence.turnNumber}
        </div>
        <div className="text-zinc-300 whitespace-pre-wrap">{sentence.text}</div>
      </div>
    );
  }
  if (sentence.kind === 'dialogue') {
    return (
      <div className="border-l-2 border-blue-700 pl-2 py-0.5">
        <div className="text-[9px] text-zinc-600">
          #{sentence.index} · dialogue · turn {sentence.turnNumber}
          {sentence.truncated && (
            <span className="text-red-400 ml-1">[truncated]</span>
          )}
        </div>
        <div className="text-blue-300 text-[10px]">
          <span className="text-blue-400">{sentence.pf.speaker}</span>
          {sentence.pf.addressee && (
            <>
              {' → '}
              <span className="text-cyan-400">{sentence.pf.addressee.join(', ')}</span>
            </>
          )}
          {sentence.pf.overhearers && (
            <>
              {' +'}
              <span className="text-yellow-500">{sentence.pf.overhearers.join(',')}</span>
            </>
          )}
          {sentence.pf.eavesdroppers && (
            <>
              {' ?'}
              <span className="text-red-400">{sentence.pf.eavesdroppers.join(',')}</span>
            </>
          )}
        </div>
        <div className="text-zinc-200 whitespace-pre-wrap">{sentence.text}</div>
      </div>
    );
  }
  if (sentence.kind === 'player_input') {
    return (
      <div className="border-l-2 border-sky-700 pl-2 py-0.5">
        <div className="text-[9px] text-zinc-600">
          #{sentence.index} · player_input · turn {sentence.turnNumber}
          {sentence.selectedIndex !== undefined && (
            <span className="ml-1 text-amber-500">[choice {sentence.selectedIndex}]</span>
          )}
        </div>
        <div className="text-sky-200 whitespace-pre-wrap text-[11px]">{sentence.text}</div>
      </div>
    );
  }
  if (sentence.kind === 'signal_input') {
    return (
      <div className="border-l-2 border-amber-700 pl-2 py-0.5">
        <div className="text-[9px] text-zinc-600">
          #{sentence.index} · signal_input · turn {sentence.turnNumber} · {sentence.choices.length} choice(s)
        </div>
        <div className="text-amber-300 text-[11px] whitespace-pre-wrap">{sentence.hint}</div>
        {sentence.choices.length > 0 && (
          <div className="text-[10px] text-zinc-500">
            {sentence.choices.map((c, i) => `${i + 1}. ${c}`).join(' / ')}
          </div>
        )}
      </div>
    );
  }
  // scene_change
  return (
    <div className="border-l-2 border-emerald-700 pl-2 py-0.5">
      <div className="text-[9px] text-zinc-600">
        #{sentence.index} · scene_change · turn {sentence.turnNumber}
        {sentence.transition && <span className="ml-1">[{sentence.transition}]</span>}
      </div>
      <div className="text-[10px] text-emerald-300">
        bg: {sentence.scene.background ?? 'null'}
        {' · sprites: '}
        {sentence.scene.sprites.length === 0
          ? '—'
          : sentence.scene.sprites.map((s: SceneState['sprites'][number]) => `${s.id}:${s.emotion}`).join(', ')}
      </div>
    </div>
  );
}

// ============================================================================
// Raw Streaming Section (M1 Step 1.7) — 最近一次 LLM generate 的原始 XML-lite 文本
// ============================================================================
//
// VN UI 只消费结构化 Sentence，原始带标签的流式文本本来就丢了。
// 这个 tab 订阅 raw-streaming-store 重新暴露，方便排查：
//   - `<d>` 标签格式问题
//   - speaker / addressee attrs 写错
//   - maxOutputTokens 中途截断
//   - 空白 / 换行畸形
//
// 每次新 generate（begin-streaming）自动清空；finalize 后残留供静态检查。
function RawStreamingSection() {
  const text = useRawStreamingStore((s) => s.text);
  const reasoning = useRawStreamingStore((s) => s.reasoning);
  const clear = useRawStreamingStore((s) => s.clear);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-zinc-500">
          Latest generate · {text.length} chars · reasoning {reasoning.length}
        </span>
        <button
          onClick={clear}
          className="text-[10px] px-2 py-0.5 rounded border border-zinc-800 text-zinc-500 hover:text-zinc-300"
        >
          clear
        </button>
      </div>

      {reasoning.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Reasoning</div>
          <pre className="text-[11px] leading-relaxed text-zinc-400 whitespace-pre-wrap bg-zinc-900 rounded px-2 py-2 max-h-48 overflow-y-auto">
            {reasoning}
          </pre>
        </div>
      )}

      <div>
        <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Output</div>
        {text.length === 0 ? (
          <Empty>尚无输出</Empty>
        ) : (
          <pre className="text-[11px] leading-relaxed text-zinc-200 whitespace-pre-wrap bg-zinc-900 rounded px-2 py-2">
            {text}
          </pre>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Helpers
// ============================================================================

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-zinc-600 py-4 text-center">{children}</div>;
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
