/**
 * PromptPreviewPanel — Prompt 组装预览 + 排序
 *
 * 展示最终发送给 LLM 的 prompt 的每个组成部分，包括：
 *   - 编剧创建的 segments（system / context）
 *   - 引擎虚拟 sections（State YAML、Memory、History、ENGINE RULES）
 *   - Token 预算使用情况
 *
 * 功能：
 *   - 拖拽排序：调整 prompt 各部分的组装顺序
 *   - 自动排序：将稳定内容放前面，优化 LLM 前缀缓存命中率
 *   - 顺序变更通过 onOrderChange 回调传出，存入 manifest
 */

import { useState, useMemo, useRef, useCallback } from 'react';
import type {
  PromptSegment,
  StateSchema,
  ProtocolVersion,
  CharacterAsset,
  BackgroundAsset,
} from '@ivn/core/types';
import { estimateTokens } from '@ivn/core/tokens';
import { buildEngineRules } from '@ivn/core/engine-rules';
import { VIRTUAL_IDS, buildStateSection } from '@ivn/core/context-assembler';
import { CURRENT_PROTOCOL_VERSION } from '@ivn/core/protocol-version';
import { cn } from '#internal/lib/utils';

// ============================================================================
// Types
// ============================================================================

export interface PromptPreviewProps {
  segments: PromptSegment[];
  stateSchema: StateSchema;
  tokenBudget?: number;
  initialPrompt?: string;
  /** 当前组装顺序（section ID 列表），undefined = 使用默认顺序 */
  assemblyOrder?: string[];
  /** 排序变更回调 */
  onOrderChange?: (order: string[]) => void;
  /** 被禁用的 section ID 列表 */
  disabledSections?: string[];
  /** 禁用状态变更回调 */
  onDisabledChange?: (disabled: string[]) => void;
  /**
   * V.3：声明式视觉 IR 协议版本。用于 ENGINE RULES 虚拟 section 的预览。
   * 缺省为当前运行协议；v1 仅用于历史读取/迁移。
   */
  protocolVersion?: ProtocolVersion;
  /** V.3：角色白名单（插值到 v2 prompt 里） */
  characters?: ReadonlyArray<CharacterAsset>;
  /** V.3：背景白名单（插值到 v2 prompt 里） */
  backgrounds?: ReadonlyArray<BackgroundAsset>;
}

interface PreviewSection {
  id: string;
  label: string;
  source: string;
  role: 'system' | 'context' | 'engine' | 'draft';
  content: string;
  tokenCount: number;
  injected: boolean;
  reason?: string;
  priority?: number;
  /** 是否为虚拟 section（引擎自动生成，不可删除） */
  virtual?: boolean;
  /** 虚拟 section 的类型标记（用于自动排序分类） */
  stability?: 'stable' | 'dynamic';
  /** 是否被用户手动禁用 */
  disabled?: boolean;
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
// Build preview sections (unordered)
// ============================================================================

function buildAllSections(
  segments: PromptSegment[],
  stateSchema: StateSchema,
  initialPrompt?: string,
  protocolVersion: ProtocolVersion = CURRENT_PROTOCOL_VERSION,
  characters: ReadonlyArray<CharacterAsset> = [],
  backgrounds: ReadonlyArray<BackgroundAsset> = [],
): PreviewSection[] {
  const vars = Object.fromEntries(
    stateSchema.variables.map((v) => [v.name, v.initial]),
  ) as Record<string, unknown>;

  // --- User segments ---
  const userSections = segments.map((seg): PreviewSection => {
    let injected = true;
    let reason: string | undefined;

    if (seg.role === 'draft') {
      injected = false;
      reason = '草稿（不注入 prompt）';
    } else if (seg.injectionRule) {
      injected = evaluateCondition(seg.injectionRule.condition, vars);
      if (!injected) {
        reason = `condition: ${seg.injectionRule.condition}`;
      }
    }

    return {
      id: seg.id,
      label: seg.label,
      source: seg.sourceDoc,
      role: seg.role,
      content: seg.content,
      tokenCount: seg.tokenCount,
      injected,
      reason,
      priority: seg.priority,
      stability: 'stable',
    };
  });

  // --- Virtual: State YAML ---
  // 用 core/context-assembler 的 buildStateSection 保证和运行时 section 完全一致
  const stateContent = buildStateSection(vars);
  const engineRulesContent = buildEngineRules({
    protocolVersion,
    characters,
    backgrounds,
  });

  const virtualSections: PreviewSection[] = [
    {
      id: VIRTUAL_IDS.STATE,
      label: 'State YAML',
      source: '引擎自动生成 · 每轮更新',
      role: 'engine',
      content: stateContent,
      tokenCount: estimateTokens(stateContent),
      injected: true,
      virtual: true,
      stability: 'dynamic',
    },
    {
      id: VIRTUAL_IDS.SCENE_CONTEXT,
      label: 'Scene Context (Focus)',
      source: '引擎自动生成 · 按 current_scene 动态排序',
      role: 'engine',
      content: '[Current Focus scene + 相关 segment 列表 — 运行时动态填充]',
      tokenCount: 0,
      injected: true,
      virtual: true,
      stability: 'dynamic',
    },
    {
      id: VIRTUAL_IDS.MEMORY,
      label: 'Memory Summaries',
      source: '引擎自动生成 · 压缩后变化',
      role: 'engine',
      content: '[Memory summaries / inherited summary — 运行时动态填充]',
      tokenCount: 0,
      injected: true,
      virtual: true,
      stability: 'dynamic',
    },
    {
      id: VIRTUAL_IDS.HISTORY,
      label: 'Recent History',
      source: '引擎自动生成 · 每轮增长',
      role: 'engine',
      content: '[Recent conversation history as messages — 运行时动态填充]',
      tokenCount: 0,
      injected: true,
      virtual: true,
      stability: 'dynamic',
    },
    {
      id: VIRTUAL_IDS.RULES,
      label: 'ENGINE RULES (tail reminder)',
      source: '引擎自动生成 · 固定',
      role: 'engine',
      content: engineRulesContent,
      tokenCount: estimateTokens(engineRulesContent),
      injected: true,
      virtual: true,
      stability: 'stable',
    },
  ];

  const initialPromptSection: PreviewSection[] = initialPrompt
    ? [
        {
          id: VIRTUAL_IDS.INITIAL_PROMPT,
          label: 'Initial User Message',
          source: 'manifest.initialPrompt · 首轮',
          role: 'engine',
          content: initialPrompt,
          tokenCount: estimateTokens(initialPrompt),
          injected: true,
          virtual: true,
          stability: 'stable',
        },
      ]
    : [];

  return [...userSections, ...virtualSections, ...initialPromptSection];
}

// ============================================================================
// Default order (matches current context-assembler behavior)
// ============================================================================

function getDefaultOrder(sections: PreviewSection[]): string[] {
  // Current assembler order: system segs → state → memory → context segs → rules → history → initial
  const systemSegs = sections
    .filter((s) => s.role === 'system' && !s.virtual)
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
  const contextSegs = sections
    .filter((s) => s.role === 'context' && !s.virtual)
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));

  return [
    ...systemSegs.map((s) => s.id),
    VIRTUAL_IDS.STATE,
    VIRTUAL_IDS.SCENE_CONTEXT,
    VIRTUAL_IDS.MEMORY,
    ...contextSegs.map((s) => s.id),
    VIRTUAL_IDS.RULES,
    VIRTUAL_IDS.HISTORY,
    VIRTUAL_IDS.INITIAL_PROMPT,
  ];
}

// ============================================================================
// Auto-sort for prefix cache optimization
// ============================================================================

function getOptimalOrder(sections: PreviewSection[]): string[] {
  // Optimal for prefix caching: all stable content first, dynamic content last
  const stable = sections.filter((s) => s.injected && s.stability === 'stable');
  const dynamic = sections.filter((s) => s.injected && s.stability === 'dynamic');

  // Within stable: system first (by priority), then context (by priority), then engine
  stable.sort((a, b) => {
    const roleOrder = (r: string) => r === 'system' ? 0 : r === 'context' ? 1 : 2;
    if (roleOrder(a.role) !== roleOrder(b.role)) return roleOrder(a.role) - roleOrder(b.role);
    return (a.priority ?? 99) - (b.priority ?? 99);
  });

  // Within dynamic: state → scene_context → memory → history (natural order)
  const dynamicOrder: string[] = [
    VIRTUAL_IDS.STATE,
    VIRTUAL_IDS.SCENE_CONTEXT,
    VIRTUAL_IDS.MEMORY,
    VIRTUAL_IDS.HISTORY,
  ];
  dynamic.sort((a, b) => {
    const ia = dynamicOrder.indexOf(a.id);
    const ib = dynamicOrder.indexOf(b.id);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  return [...stable.map((s) => s.id), ...dynamic.map((s) => s.id)];
}

// ============================================================================
// Sort sections by order
// ============================================================================

function sortByOrder(sections: PreviewSection[], order: string[]): PreviewSection[] {
  const orderMap = new Map(order.map((id, i) => [id, i]));
  // Sort all sections that could be injected (including disabled ones) by order
  const sortable = sections.filter((s) => s.injected || s.disabled);
  const skipped = sections.filter((s) => !s.injected && !s.disabled);

  sortable.sort((a, b) => {
    const ia = orderMap.get(a.id) ?? 999;
    const ib = orderMap.get(b.id) ?? 999;
    return ia - ib;
  });

  return [...sortable, ...skipped];
}

// ============================================================================
// Component
// ============================================================================

export function PromptPreviewPanel({
  segments,
  stateSchema,
  tokenBudget = 120000,
  initialPrompt,
  assemblyOrder,
  onOrderChange,
  disabledSections = [],
  onDisabledChange,
  protocolVersion = CURRENT_PROTOCOL_VERSION,
  characters,
  backgrounds,
}: PromptPreviewProps) {
  const disabledSet = useMemo(() => new Set(disabledSections), [disabledSections]);

  const allSections = useMemo(
    () => {
      return buildAllSections(
        segments,
        stateSchema,
        initialPrompt,
        protocolVersion,
        characters,
        backgrounds,
      ).map((section) => (
        disabledSet.has(section.id) ? { ...section, disabled: true } : section
      ));
    },
    [segments, stateSchema, initialPrompt, disabledSet, protocolVersion, characters, backgrounds],
  );

  // Compute effective order
  const effectiveOrder = useMemo(() => {
    if (assemblyOrder && assemblyOrder.length > 0) {
      // Merge: keep saved order, append any new sections not in the order
      const existing = new Set(assemblyOrder);
      const sectionIds = new Set(allSections.map((s) => s.id));
      const newIds = allSections.filter((s) => s.injected && !existing.has(s.id)).map((s) => s.id);
      return [...assemblyOrder.filter((id) => sectionIds.has(id)), ...newIds];
    }
    return getDefaultOrder(allSections);
  }, [assemblyOrder, allSections]);

  const sortedSections = useMemo(
    () => sortByOrder(allSections, effectiveOrder),
    [allSections, effectiveOrder],
  );

  const injectedSections = sortedSections.filter((s) => s.injected && !s.disabled);
  const disabledSectionsList = sortedSections.filter((s) => s.disabled);
  const skippedSections = sortedSections.filter((s) => !s.injected && !s.disabled);
  const totalTokens = injectedSections.reduce((sum, s) => sum + s.tokenCount, 0);

  // Toggle enable/disable handler
  const handleToggleSection = useCallback((sectionId: string) => {
    if (!onDisabledChange) return;
    const newDisabled = disabledSet.has(sectionId)
      ? disabledSections.filter((id) => id !== sectionId)
      : [...disabledSections, sectionId];
    onDisabledChange(newDisabled);
  }, [disabledSections, disabledSet, onDisabledChange]);
  const availableBudget = tokenBudget - 4096;
  const usagePercent = Math.round((totalTokens / availableBudget) * 100);

  // --- Drag state ---
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const dragCounterRef = useRef(0);

  const handleDragStart = useCallback((id: string) => {
    setDragId(id);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, id: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverId(id);
  }, []);

  const handleDragLeave = useCallback(() => {
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      setDragOverId(null);
      dragCounterRef.current = 0;
    }
  }, []);

  const handleDragEnter = useCallback(() => {
    dragCounterRef.current++;
  }, []);

  const handleDrop = useCallback((targetId: string) => {
    if (!dragId || dragId === targetId) {
      setDragId(null);
      setDragOverId(null);
      return;
    }

    const injectedIds = injectedSections.map((s) => s.id);
    const fromIdx = injectedIds.indexOf(dragId);
    const toIdx = injectedIds.indexOf(targetId);
    if (fromIdx === -1 || toIdx === -1) return;

    const reorderedIds = injectedIds.filter((id) => id !== dragId);
    const newOrder = [
      ...reorderedIds.slice(0, toIdx),
      dragId,
      ...reorderedIds.slice(toIdx),
    ];

    onOrderChange?.(newOrder);
    setDragId(null);
    setDragOverId(null);
    dragCounterRef.current = 0;
  }, [dragId, injectedSections, onOrderChange]);

  const handleDragEnd = useCallback(() => {
    setDragId(null);
    setDragOverId(null);
    dragCounterRef.current = 0;
  }, []);

  // --- Auto sort ---
  const handleAutoSort = useCallback(() => {
    const optimal = getOptimalOrder(allSections);
    onOrderChange?.(optimal);
  }, [allSections, onOrderChange]);

  // --- Reset to default ---
  const handleResetOrder = useCallback(() => {
    const defaultOrder = getDefaultOrder(allSections);
    onOrderChange?.(defaultOrder);
  }, [allSections, onOrderChange]);

  // Check if current order differs from optimal
  const isOptimal = useMemo(() => {
    const optimal = getOptimalOrder(allSections);
    return JSON.stringify(effectiveOrder) === JSON.stringify(optimal);
  }, [effectiveOrder, allSections]);

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

        {/* Sort controls */}
        {onOrderChange && (
          <div className="flex items-center gap-2">
            <button
              onClick={handleAutoSort}
              disabled={isOptimal}
              className={cn(
                'text-[10px] px-2 py-1 rounded border transition-colors',
                isOptimal
                  ? 'border-zinc-800 text-zinc-600 cursor-default'
                  : 'border-emerald-800/50 bg-emerald-950/30 text-emerald-400 hover:border-emerald-600',
              )}
            >
              {isOptimal ? '已最优排序' : '自动排序（优化缓存）'}
            </button>
            <button
              onClick={handleResetOrder}
              className="text-[10px] px-2 py-1 rounded border border-zinc-800 text-zinc-500 hover:text-zinc-300 hover:border-zinc-600 transition-colors"
            >
              重置默认
            </button>
            <span className="text-[9px] text-zinc-600 ml-auto">拖拽调整顺序</span>
          </div>
        )}

        {/* Injected sections (draggable) */}
        <div className="space-y-1">
          <h3 className="text-[10px] font-medium text-zinc-400 uppercase tracking-wider">
            Assembly Order ({injectedSections.length})
          </h3>
          {injectedSections.map((sec, idx) => (
            <SectionCard
              key={sec.id}
              section={sec}
              index={idx}
              draggable={!!onOrderChange}
              isDragging={dragId === sec.id}
              isDragOver={dragOverId === sec.id}
              onDragStart={() => handleDragStart(sec.id)}
              onDragOver={(e) => handleDragOver(e, sec.id)}
              onDragEnter={handleDragEnter}
              onDragLeave={handleDragLeave}
              onDrop={() => handleDrop(sec.id)}
              onDragEnd={handleDragEnd}
              onToggleDisabled={onDisabledChange ? () => handleToggleSection(sec.id) : undefined}
            />
          ))}
        </div>

        {/* Disabled sections (user toggle) */}
        {disabledSectionsList.length > 0 && (
          <div className="space-y-1">
            <h3 className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider">
              Disabled ({disabledSectionsList.length})
            </h3>
            {disabledSectionsList.map((sec) => (
              <SectionCard
                key={sec.id}
                section={sec}
                onToggleDisabled={onDisabledChange ? () => handleToggleSection(sec.id) : undefined}
              />
            ))}
          </div>
        )}

        {/* Skipped sections (condition not met) */}
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
// SectionCard
// ============================================================================

function SectionCard({
  section,
  index,
  draggable = false,
  isDragging = false,
  isDragOver = false,
  onDragStart,
  onDragOver,
  onDragEnter,
  onDragLeave,
  onDrop,
  onDragEnd,
  onToggleDisabled,
}: {
  section: PreviewSection;
  index?: number;
  draggable?: boolean;
  isDragging?: boolean;
  isDragOver?: boolean;
  onDragStart?: () => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDragEnter?: () => void;
  onDragLeave?: () => void;
  onDrop?: () => void;
  onDragEnd?: () => void;
  onToggleDisabled?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      draggable={draggable && section.injected}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDrop={(e) => { e.preventDefault(); onDrop?.(); }}
      onDragEnd={onDragEnd}
      className={cn(
        'border rounded text-[11px] transition-all',
        section.disabled
          ? 'border-zinc-800/50 bg-zinc-950/50 opacity-50'
          : section.injected
            ? 'border-zinc-800 bg-zinc-900/30'
            : 'border-zinc-800/50 bg-zinc-950/50 opacity-60',
        isDragging && 'opacity-40',
        isDragOver && 'border-emerald-600 bg-emerald-950/20',
        draggable && section.injected && !section.disabled && 'cursor-grab active:cursor-grabbing',
      )}
    >
      <div className="w-full px-2.5 py-1.5 flex items-start gap-2">
        {/* Enable/disable toggle */}
        {onToggleDisabled && (
          <button
            onClick={(e) => { e.stopPropagation(); onToggleDisabled(); }}
            className={cn(
              'flex-none mt-0.5 w-3.5 h-3.5 rounded border text-[8px] flex items-center justify-center transition-colors',
              section.disabled
                ? 'border-zinc-600 text-zinc-600 hover:border-zinc-400 hover:text-zinc-400'
                : 'border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-500',
            )}
            title={section.disabled ? '启用此 section' : '禁用此 section'}
          >
            {!section.disabled && '✓'}
          </button>
        )}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex-1 text-left flex items-start gap-2 hover:bg-zinc-800/30 transition-colors -m-0.5 p-0.5 rounded"
      >
        {/* Order number + drag handle */}
        {index !== undefined && section.injected && (
          <span className="flex-none mt-0.5 text-[9px] text-zinc-600 w-3 text-right font-mono">
            {index + 1}
          </span>
        )}

        {/* Status indicator */}
        <span className={cn(
          'flex-none mt-0.5 w-1.5 h-1.5 rounded-full',
          section.injected
            ? section.virtual
              ? section.stability === 'dynamic' ? 'bg-amber-500' : 'bg-emerald-500'
              : 'bg-emerald-500'
            : 'bg-zinc-600',
        )} />

        <div className="flex-1 min-w-0">
          {/* Label + role badge + stability */}
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
            {section.stability && section.injected && (
              <span className={cn(
                'flex-none text-[9px] px-1 py-0 rounded',
                section.stability === 'stable'
                  ? 'bg-emerald-950/50 text-emerald-600'
                  : 'bg-amber-950/50 text-amber-600',
              )}>
                {section.stability === 'stable' ? '稳定' : '动态'}
              </span>
            )}
          </div>

          {/* Source + tokens */}
          <div className="flex items-center gap-2 mt-0.5 text-[10px] text-zinc-500">
            <span className="truncate">{section.source}</span>
            <span className="flex-none font-mono">
              {section.tokenCount > 0
                ? `~${section.tokenCount.toLocaleString()} tok`
                : '运行时'}
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
      </div>

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
