/**
 * InheritancePanel — 跨章继承确认界面
 *
 * Step 3.5: 展示三层 fallback 继承配置：
 *   1. 编剧显式声明（最高优先级）
 *   2. Architect Agent 自动推断
 *   3. GM 运行时补充（可选）
 *
 * 编剧可勾选/取消继承字段，输出 CrossChapterConfig。
 */

import { useState, useCallback } from 'react';
import type { StateVariable, CrossChapterConfig } from '../../core/types';
import { cn } from '../../lib/utils';

// ============================================================================
// Types
// ============================================================================

export type InheritanceSource = 'explicit' | 'inferred' | 'none';

export interface InheritanceField {
  name: string;
  type: string;
  description: string;
  source: InheritanceSource;
  inherited: boolean;
}

export interface InheritancePanelProps {
  /** State variables from current chapter */
  currentChapterVars: StateVariable[];
  /** State variables from previous chapter (for auto-inference) */
  prevChapterVars?: StateVariable[];
  /** Existing config (from Architect Agent) */
  initialConfig?: CrossChapterConfig;
  onConfirm: (config: CrossChapterConfig) => void;
}

// ============================================================================
// InheritancePanel
// ============================================================================

export function InheritancePanel({
  currentChapterVars,
  prevChapterVars = [],
  initialConfig,
  onConfirm,
}: InheritancePanelProps) {
  const [fields, setFields] = useState<InheritanceField[]>(() => {
    const explicitInherit = new Set(initialConfig?.inherit ?? []);
    const explicitExclude = new Set(initialConfig?.exclude ?? []);
    const prevNames = new Set(prevChapterVars.map((v) => v.name));

    return currentChapterVars.map((v) => {
      let source: InheritanceSource = 'none';
      let inherited = false;

      if (explicitInherit.has(v.name)) {
        source = 'explicit';
        inherited = true;
      } else if (explicitExclude.has(v.name)) {
        source = 'explicit';
        inherited = false;
      } else if (prevNames.has(v.name)) {
        source = 'inferred';
        inherited = true;   // Auto-inferred: same-named field defaults to inherit
      }

      return {
        name: v.name,
        type: v.type,
        description: v.description,
        source,
        inherited,
      };
    });
  });

  const toggleField = useCallback((name: string) => {
    setFields((prev) =>
      prev.map((f) =>
        f.name === name ? { ...f, inherited: !f.inherited, source: 'explicit' } : f,
      ),
    );
  }, []);

  const handleConfirm = useCallback(() => {
    const inherit = fields.filter((f) => f.inherited).map((f) => f.name);
    const exclude = fields.filter((f) => !f.inherited && f.source !== 'none').map((f) => f.name);
    onConfirm({ inherit, exclude });
  }, [fields, onConfirm]);

  const inheritedCount = fields.filter((f) => f.inherited).length;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex-none px-6 py-4 border-b border-zinc-800">
        <h2 className="text-lg font-medium text-zinc-200">跨章继承配置</h2>
        <p className="text-sm text-zinc-500 mt-1">
          确认哪些状态变量从上一章继承。未声明的字段由 Architect Agent 自动推断。
        </p>
      </div>

      {/* Legend */}
      <div className="flex-none px-6 py-2 flex gap-4 text-xs border-b border-zinc-800/50">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-green-500" /> 编剧声明
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-yellow-500" /> Agent 推断
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-zinc-600" /> 新字段
        </span>
      </div>

      {/* Field list */}
      <div className="flex-1 overflow-y-auto px-6 py-3 space-y-1">
        {fields.map((field) => (
          <div
            key={field.name}
            onClick={() => toggleField(field.name)}
            className={cn(
              'flex items-center gap-3 px-4 py-2.5 rounded-lg cursor-pointer transition-colors',
              field.inherited ? 'bg-zinc-800/70' : 'bg-zinc-900/30',
              'hover:bg-zinc-800',
            )}
          >
            {/* Checkbox */}
            <div className={cn(
              'w-4 h-4 rounded border flex items-center justify-center flex-none',
              field.inherited
                ? 'bg-blue-600 border-blue-600'
                : 'border-zinc-600',
            )}>
              {field.inherited && (
                <svg className="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M2 6l3 3 5-5" />
                </svg>
              )}
            </div>

            {/* Source indicator */}
            <span className={cn(
              'w-2 h-2 rounded-full flex-none',
              field.source === 'explicit' && 'bg-green-500',
              field.source === 'inferred' && 'bg-yellow-500',
              field.source === 'none' && 'bg-zinc-600',
            )} />

            {/* Field info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-mono text-zinc-200">{field.name}</span>
                <span className="text-xs bg-zinc-800 px-1 rounded text-zinc-500">{field.type}</span>
              </div>
              <div className="text-xs text-zinc-500 truncate">{field.description}</div>
            </div>

            {/* Status */}
            <span className={cn(
              'text-xs flex-none',
              field.inherited ? 'text-green-400' : 'text-zinc-600',
            )}>
              {field.inherited ? '继承' : '不继承'}
            </span>
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="flex-none px-6 py-4 border-t border-zinc-800 flex items-center justify-between">
        <span className="text-sm text-zinc-500">
          {inheritedCount} / {fields.length} 个字段将被继承
        </span>
        <button
          onClick={handleConfirm}
          className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm hover:bg-green-500 transition-colors"
        >
          确认继承配置
        </button>
      </div>
    </div>
  );
}
