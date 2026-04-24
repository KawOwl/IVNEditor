/**
 * EdgeEditPanel — 边编辑器
 *
 * 点击边后弹出，可编辑边的标签。
 * FlowEdge 已简化：仅 from/to/label，无条件表达式
 * （FlowGraph 不做运行时路由）。
 */

import { useState, useCallback } from 'react';
import type { FlowEdge } from '@ivn/core/types';

// ============================================================================
// Props
// ============================================================================

export interface EdgeEditPanelProps {
  edge: FlowEdge;
  onSave: (edge: FlowEdge) => void;
  onDelete: () => void;
  onClose: () => void;
}

// ============================================================================
// EdgeEditPanel
// ============================================================================

export function EdgeEditPanel({ edge, onSave, onDelete, onClose }: EdgeEditPanelProps) {
  const [label, setLabel] = useState(edge.label ?? '');

  const handleSave = useCallback(() => {
    onSave({
      ...edge,
      label: label || undefined,
    });
  }, [edge, label, onSave]);

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
