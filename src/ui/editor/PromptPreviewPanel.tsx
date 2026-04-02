/**
 * PromptPreviewPanel — Prompt 组装预览
 *
 * 不需要启动 LLM，模拟 ContextAssembler 的拼接逻辑，
 * 展示最终发送给 LLM 的 system prompt 的每个组成部分：
 *   - 每段来源（文件名、role、priority）
 *   - 注入状态（已注入 / 条件不满足）
 *   - 引擎自动追加的部分（State YAML、ENGINE RULES）
 *   - Token 预算使用情况
 */

import { useState, useMemo } from 'react';
import type { PromptSegment, StateSchema } from '../../core/types';
import { estimateTokens } from '../../core/memory';
import { cn } from '../../lib/utils';

// ============================================================================
// Types
// ============================================================================

export interface PromptPreviewProps {
  segments: PromptSegment[];
  stateSchema: StateSchema;
  tokenBudget?: number;
  initialPrompt?: string;
}

interface PreviewSection {
  id: string;
  label: string;
  source: string;       // 来源说明
  role: 'system' | 'context' | 'engine' | 'draft';
  content: string;
  tokenCount: number;
  injected: boolean;
  reason?: string;       // 未注入的原因
  priority?: number;
}

// ============================================================================
// Condition evaluator (mirror of context-assembler)
// ============================================================================

function evaluateCondition(
  condition: string,
  vars: Record<string, unknown>,
): boolean {
  try {
    const keys = Object.keys(vars);
    const values = keys.map((k) => vars[k]);
    const fn = new Function(
      ...keys,
      `try { return !!(${condition}); } catch { return false; }`,
    );
    return fn(...values) as boolean;
  } catch {
    return false;
  }
}

// ============================================================================
// Build preview sections
// ============================================================================

function buildPreviewSections(
  segments: PromptSegment[],
  stateSchema: StateSchema,
  tokenBudget: number,
  initialPrompt?: string,
): PreviewSection[] {
  const outputReserve = 4096;
  const availableBudget = tokenBudget - outputReserve;

  // Build initial state vars from schema
  const vars: Record<string, unknown> = {};
  for (const v of stateSchema.variables) {
    vars[v.name] = v.initial;
  }

  const sections: PreviewSection[] = [];

  // --- 1. Evaluate each segment ---
  for (const seg of segments) {
    let injected = true;
    let reason: string | undefined;

    // Draft segments are never injected
    if (seg.role === 'draft') {
      injected = false;
      reason = '草稿（不注入 prompt）';
    } else if (seg.injectionRule) {
      injected = evaluateCondition(seg.injectionRule.condition, vars);
      if (!injected) {
        reason = `condition: ${seg.injectionRule.condition}`;
      }
    }

    sections.push({
      id: seg.id,
      label: seg.label,
      source: seg.sourceDoc,
      role: seg.role,
      content: seg.content,
      tokenCount: seg.tokenCount,
      injected,
      reason,
      priority: seg.priority,
    });
  }

  // Sort: system first (by priority), then context (by priority)
  sections.sort((a, b) => {
    if (a.role !== b.role) {
      if (a.role === 'system') return -1;
      if (b.role === 'system') return 1;
    }
    return (a.priority ?? 99) - (b.priority ?? 99);
  });

  // --- 2. Engine auto-appended sections ---

  // State YAML
  const stateYaml = stateSchema.variables
    .map((v) => `  ${v.name}: ${JSON.stringify(v.initial)}`)
    .join('\n');
  const stateContent = `---\nINTERNAL_STATE:\n${stateYaml}\n---`;
  const stateTokens = estimateTokens(stateContent);

  sections.push({
    id: '_engine_state',
    label: 'State YAML (initial)',
    source: 'engine auto-generated',
    role: 'engine',
    content: stateContent,
    tokenCount: stateTokens,
    injected: true,
  });

  // ENGINE RULES tail
  const rulesContent =
    `---\n[ENGINE RULES]\n` +
    `你运行在互动叙事引擎中。你是GM，不是玩家。\n` +
    `- 绝对不要替玩家行动、观察、思考或说话。\n` +
    `- 你的回复结束后，引擎会自动等待玩家输入（和聊天一样）。\n` +
    `- 叙事到达需要等待玩家的时刻时，正常结束你的回复即可。\n` +
    `- 可用 update_state 更新状态变量，signal_input_needed 提供输入提示。\n` +
    `- 输出只包含叙事正文和工具调用，不要输出计划、分析或元叙述。\n` +
    `---`;
  const rulesTokens = estimateTokens(rulesContent);

  sections.push({
    id: '_engine_rules',
    label: 'ENGINE RULES (tail reminder)',
    source: 'engine auto-generated',
    role: 'engine',
    content: rulesContent,
    tokenCount: rulesTokens,
    injected: true,
  });

  // Initial prompt (first user message)
  if (initialPrompt) {
    sections.push({
      id: '_initial_prompt',
      label: 'Initial User Message',
      source: 'manifest.initialPrompt',
      role: 'engine',
      content: initialPrompt,
      tokenCount: estimateTokens(initialPrompt),
      injected: true,
    });
  }

  // --- 3. Calculate budget usage for injected sections ---
  let usedTokens = 0;
  const budgetExceeded: string[] = [];
  for (const sec of sections) {
    if (!sec.injected) continue;
    usedTokens += sec.tokenCount;
    if (usedTokens > availableBudget) {
      budgetExceeded.push(sec.id);
    }
  }

  // Mark budget-exceeded sections
  for (const sec of sections) {
    if (budgetExceeded.includes(sec.id) && sec.injected) {
      sec.injected = false;
      sec.reason = 'token budget exceeded';
    }
  }

  return sections;
}

// ============================================================================
// Component
// ============================================================================

export function PromptPreviewPanel({
  segments,
  stateSchema,
  tokenBudget = 120000,
  initialPrompt,
}: PromptPreviewProps) {
  const sections = useMemo(
    () => buildPreviewSections(segments, stateSchema, tokenBudget, initialPrompt),
    [segments, stateSchema, tokenBudget, initialPrompt],
  );

  const injectedSections = sections.filter((s) => s.injected);
  const skippedSections = sections.filter((s) => !s.injected);
  const totalTokens = injectedSections.reduce((sum, s) => sum + s.tokenCount, 0);
  const availableBudget = tokenBudget - 4096;
  const usagePercent = Math.round((totalTokens / availableBudget) * 100);

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-3 space-y-4">
        {/* Token budget bar */}
        <div className="space-y-1.5">
          <div className="flex justify-between text-[11px]">
            <span className="text-zinc-400">Prompt Token 使用</span>
            <span className={cn(
              'font-mono',
              usagePercent > 90 ? 'text-red-400' :
              usagePercent > 70 ? 'text-amber-400' : 'text-emerald-400',
            )}>
              {totalTokens.toLocaleString()} / {availableBudget.toLocaleString()} ({usagePercent}%)
            </span>
          </div>
          <div className="h-2 bg-zinc-800 rounded-full overflow-hidden flex">
            {injectedSections.map((sec) => {
              const widthPercent = (sec.tokenCount / availableBudget) * 100;
              if (widthPercent < 0.3) return null;
              return (
                <div
                  key={sec.id}
                  title={`${sec.label}: ~${sec.tokenCount.toLocaleString()} tokens`}
                  className={cn(
                    'h-full',
                    sec.role === 'system' ? 'bg-purple-600' :
                    sec.role === 'context' ? 'bg-cyan-600' :
                    'bg-zinc-600',
                  )}
                  style={{ width: `${widthPercent}%` }}
                />
              );
            })}
          </div>
          <div className="flex gap-3 text-[10px] text-zinc-500">
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-sm bg-purple-600 inline-block" /> system
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-sm bg-cyan-600 inline-block" /> context
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-sm bg-zinc-600 inline-block" /> engine
            </span>
          </div>
        </div>

        {/* Injected sections */}
        <div className="space-y-1">
          <h3 className="text-[10px] font-medium text-zinc-400 uppercase tracking-wider">
            Injected ({injectedSections.length})
          </h3>
          {injectedSections.map((sec) => (
            <SectionCard key={sec.id} section={sec} />
          ))}
        </div>

        {/* Skipped sections */}
        {skippedSections.length > 0 && (
          <div className="space-y-1">
            <h3 className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider">
              Skipped ({skippedSections.length})
            </h3>
            {skippedSections.map((sec) => (
              <SectionCard key={sec.id} section={sec} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// SectionCard — 单个 section 展示
// ============================================================================

function SectionCard({ section }: { section: PreviewSection }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={cn(
      'border rounded text-[11px]',
      section.injected
        ? 'border-zinc-800 bg-zinc-900/30'
        : 'border-zinc-800/50 bg-zinc-950/50 opacity-60',
    )}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-2.5 py-1.5 text-left flex items-start gap-2 hover:bg-zinc-800/30 transition-colors"
      >
        {/* Status indicator */}
        <span className={cn(
          'flex-none mt-0.5 w-1.5 h-1.5 rounded-full',
          section.injected ? 'bg-emerald-500' : 'bg-zinc-600',
        )} />

        <div className="flex-1 min-w-0">
          {/* Label + role badge */}
          <div className="flex items-center gap-1.5">
            <span className={cn(
              'font-medium truncate',
              section.injected ? 'text-zinc-200' : 'text-zinc-500',
            )}>
              {section.label}
            </span>
            <span className={cn(
              'flex-none text-[9px] px-1 py-0 rounded',
              section.role === 'system' ? 'bg-purple-950 text-purple-400' :
              section.role === 'context' ? 'bg-cyan-950 text-cyan-400' :
              section.role === 'draft' ? 'bg-zinc-800 text-zinc-500' :
              'bg-zinc-800 text-zinc-400',
            )}>
              {section.role}
            </span>
            {section.priority !== undefined && (
              <span className="flex-none text-[9px] text-zinc-600">
                P{section.priority}
              </span>
            )}
          </div>

          {/* Source + tokens */}
          <div className="flex items-center gap-2 mt-0.5 text-[10px] text-zinc-500">
            <span className="truncate">{section.source}</span>
            <span className="flex-none font-mono">
              ~{section.tokenCount.toLocaleString()} tok
            </span>
          </div>

          {/* Reason for skipping */}
          {!section.injected && section.reason && (
            <div className="mt-0.5 text-[10px] text-amber-600">
              {section.reason}
            </div>
          )}
        </div>

        <span className="flex-none text-zinc-600 text-[10px] mt-0.5">
          {expanded ? '▾' : '▸'}
        </span>
      </button>

      {expanded && (
        <pre className="px-2.5 py-2 text-[10px] text-zinc-400 whitespace-pre-wrap border-t border-zinc-800 bg-zinc-900/50 max-h-64 overflow-y-auto leading-relaxed font-mono">
          {section.content.length > 3000
            ? section.content.slice(0, 3000) + '\n\n... (truncated, ' + section.content.length.toLocaleString() + ' chars total)'
            : section.content}
        </pre>
      )}
    </div>
  );
}
