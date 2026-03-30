/**
 * EdgeEditPanel — 边/条件编辑器
 *
 * Step 3.3: 点击边后弹出，可编辑条件表达式。
 * 提供下拉选择状态变量 + 运算符 + 值的可视化编辑，
 * 同时支持直接编辑原始表达式。
 */

import { useState, useCallback } from 'react';
import type { FlowEdge, StateVariable } from '../../core/types';

// ============================================================================
// Props
// ============================================================================

export interface EdgeEditPanelProps {
  edge: FlowEdge;
  stateVariables: StateVariable[];
  onSave: (edge: FlowEdge) => void;
  onDelete: () => void;
  onClose: () => void;
}

// ============================================================================
// Operators
// ============================================================================

const OPERATORS = [
  { value: '==', label: '等于 (==)' },
  { value: '!=', label: '不等于 (!=)' },
  { value: '>', label: '大于 (>)' },
  { value: '>=', label: '大于等于 (>=)' },
  { value: '<', label: '小于 (<)' },
  { value: '<=', label: '小于等于 (<=)' },
  { value: '.includes(', label: '包含 (.includes)' },
] as const;

// ============================================================================
// EdgeEditPanel
// ============================================================================

export function EdgeEditPanel({ edge, stateVariables, onSave, onDelete, onClose }: EdgeEditPanelProps) {
  const [label, setLabel] = useState(edge.label ?? '');
  const [condition, setCondition] = useState(edge.condition ?? '');
  const [mode, setMode] = useState<'visual' | 'raw'>('visual');

  // Visual mode state
  const [varName, setVarName] = useState('');
  const [operator, setOperator] = useState('==');
  const [compareValue, setCompareValue] = useState('');

  const buildCondition = useCallback(() => {
    if (!varName) return '';
    if (operator === '.includes(') {
      return `${varName}.includes('${compareValue}')`;
    }
    // Auto-detect if value is a number
    const isNum = !isNaN(Number(compareValue)) && compareValue !== '';
    const val = isNum ? compareValue : `'${compareValue}'`;
    return `${varName} ${operator} ${val}`;
  }, [varName, operator, compareValue]);

  const handleApplyVisual = useCallback(() => {
    const built = buildCondition();
    if (built) setCondition(built);
  }, [buildCondition]);

  const handleSave = useCallback(() => {
    onSave({
      ...edge,
      label: label || undefined,
      condition: condition || undefined,
    });
  }, [edge, label, condition, onSave]);

  return (
    <div className="w-80 bg-zinc-900 border-l border-zinc-800 flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
        <h3 className="text-sm font-medium text-zinc-200">编辑边</h3>
        <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 text-xs">✕</button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {/* From → To */}
        <div className="text-sm text-zinc-400">
          <span className="text-zinc-300">{edge.from}</span>
          <span className="mx-2">→</span>
          <span className="text-zinc-300">{edge.to}</span>
        </div>

        {/* Label */}
        <Field label="标签">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="边的显示标签"
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-200"
          />
        </Field>

        {/* Mode toggle */}
        <div className="flex gap-2">
          <ModeButton active={mode === 'visual'} onClick={() => setMode('visual')}>
            可视化编辑
          </ModeButton>
          <ModeButton active={mode === 'raw'} onClick={() => setMode('raw')}>
            原始表达式
          </ModeButton>
        </div>

        {/* Visual mode */}
        {mode === 'visual' && (
          <div className="space-y-3">
            <Field label="状态变量">
              <select
                value={varName}
                onChange={(e) => setVarName(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-200"
              >
                <option value="">选择变量...</option>
                {stateVariables.map((v) => (
                  <option key={v.name} value={v.name}>
                    {v.name} ({v.type})
                  </option>
                ))}
              </select>
            </Field>

            <Field label="运算符">
              <select
                value={operator}
                onChange={(e) => setOperator(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-200"
              >
                {OPERATORS.map((op) => (
                  <option key={op.value} value={op.value}>{op.label}</option>
                ))}
              </select>
            </Field>

            <Field label="比较值">
              <input
                value={compareValue}
                onChange={(e) => setCompareValue(e.target.value)}
                placeholder="值"
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-200"
              />
            </Field>

            <button
              onClick={handleApplyVisual}
              disabled={!varName}
              className="text-xs text-blue-400 hover:text-blue-300 disabled:text-zinc-600"
            >
              应用到条件表达式 →
            </button>
          </div>
        )}

        {/* Raw condition */}
        <Field label="条件表达式 (JavaScript)">
          <textarea
            value={condition}
            onChange={(e) => setCondition(e.target.value)}
            placeholder="例如: trust_level >= 3"
            rows={3}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-200 font-mono resize-none"
          />
        </Field>

        {!condition && (
          <div className="text-xs text-zinc-600">
            留空表示无条件（默认路径）
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex-none px-4 py-3 border-t border-zinc-800 flex gap-2">
        <button
          onClick={handleSave}
          className="flex-1 px-3 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-500"
        >
          保存
        </button>
        <button
          onClick={onDelete}
          className="px-3 py-1.5 text-red-400 hover:text-red-300 text-sm"
        >
          删除边
        </button>
        <button
          onClick={onClose}
          className="px-3 py-1.5 text-zinc-400 hover:text-zinc-300 text-sm"
        >
          取消
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// Shared
// ============================================================================

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs text-zinc-400 mb-1 block">{label}</label>
      {children}
    </div>
  );
}

function ModeButton({ active, onClick, children }: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`text-xs px-2 py-1 rounded transition-colors ${
        active ? 'bg-zinc-700 text-zinc-200' : 'text-zinc-500 hover:text-zinc-400'
      }`}
    >
      {children}
    </button>
  );
}
