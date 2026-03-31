/**
 * NodeEditPanel — 节点编辑侧边面板
 *
 * 点击节点后弹出，可修改节点的 label、description 和关联的 promptSegments。
 * FlowNode 已简化：仅 id/label/description/promptSegments。
 */

import { useState, useCallback } from 'react';
import type { FlowNode } from '../../core/types';

// ============================================================================
// Props
// ============================================================================

export interface NodeEditPanelProps {
  node: FlowNode;
  onSave: (node: FlowNode) => void;
  onClose: () => void;
}

// ============================================================================
// NodeEditPanel
// ============================================================================

export function NodeEditPanel({ node, onSave, onClose }: NodeEditPanelProps) {
  const [label, setLabel] = useState(node.label);
  const [description, setDescription] = useState(node.description ?? '');

  const handleSave = useCallback(() => {
    onSave({
      ...node,
      label,
      description: description || undefined,
    });
  }, [node, label, description, onSave]);

  return (
    <div className="w-80 bg-zinc-900 border-l border-zinc-800 flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
        <h3 className="text-sm font-medium text-zinc-200">编辑节点</h3>
        <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 text-xs">✕</button>
      </div>

      {/* Form */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {/* ID (read-only) */}
        <Field label="节点 ID">
          <div className="text-xs text-zinc-500 font-mono">{node.id}</div>
        </Field>

        {/* Label */}
        <Field label="节点名称">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-200"
          />
        </Field>

        {/* Description */}
        <Field label="描述">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="节点的简短描述"
            rows={3}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-200 resize-none"
          />
        </Field>

        {/* Prompt Segments */}
        <Field label="关联 Prompt Segments">
          <div className="text-xs text-zinc-500">
            {node.promptSegments.length > 0
              ? node.promptSegments.join(', ')
              : '无（将在 Prompt 编辑器中关联）'}
          </div>
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
// Shared Components
// ============================================================================

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs text-zinc-400 mb-1 block">{label}</label>
      {children}
    </div>
  );
}
