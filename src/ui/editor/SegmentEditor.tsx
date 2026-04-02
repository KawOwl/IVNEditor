/**
 * SegmentEditor — Prompt 片段编辑器
 *
 * Step 3.4: 查看和编辑 PromptSegment 内容。
 * 支持 '/' 菜单引用工具（类似 Notion slash commands）。
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import type { PromptSegment, SegmentType, SegmentRole } from '../../core/types';
import { cn } from '../../lib/utils';

// ============================================================================
// Tool References
// ============================================================================

const TOOL_REFERENCES = [
  { id: 'update_state', label: '更新状态', description: 'update_state(patch)' },
  { id: 'signal_input_needed', label: '等待输入', description: 'signal_input_needed(hint?)' },
  { id: 'read_state', label: '读取状态', description: 'read_state(keys?)' },
  { id: 'query_changelog', label: '查询变更', description: 'query_changelog(filter)' },
  { id: 'pin_memory', label: '固定记忆', description: 'pin_memory(content, tags?)' },
  { id: 'query_memory', label: '搜索记忆', description: 'query_memory(query)' },
  { id: 'inject_context', label: '注入文档', description: 'inject_context(doc_id)' },
  { id: 'list_context', label: '列出文档', description: 'list_context()' },
  { id: 'advance_flow', label: '跳转节点', description: 'advance_flow(node_id)' },
  { id: 'set_mood', label: '设置氛围', description: 'set_mood(mood)' },
  { id: 'show_image', label: '显示图片', description: 'show_image(asset_id)' },
];

// ============================================================================
// Props
// ============================================================================

export interface SegmentEditorProps {
  segments: PromptSegment[];
  onSave: (segments: PromptSegment[]) => void;
}

// ============================================================================
// SegmentEditor
// ============================================================================

export function SegmentEditor({ segments, onSave }: SegmentEditorProps) {
  const [selectedId, setSelectedId] = useState<string | null>(segments[0]?.id ?? null);
  const selected = segments.find((s) => s.id === selectedId);

  const handleSegmentUpdate = useCallback(
    (updated: PromptSegment) => {
      onSave(segments.map((s) => (s.id === updated.id ? updated : s)));
    },
    [segments, onSave],
  );

  return (
    <div className="flex h-full">
      {/* Segment list */}
      <div className="w-64 border-r border-zinc-800 overflow-y-auto">
        <div className="px-3 py-2 text-xs text-zinc-500 uppercase tracking-wider">
          Prompt 片段 ({segments.length})
        </div>
        {segments.map((seg) => (
          <button
            key={seg.id}
            onClick={() => setSelectedId(seg.id)}
            className={cn(
              'w-full text-left px-3 py-2 text-sm border-b border-zinc-800/50 transition-colors',
              selectedId === seg.id
                ? 'bg-zinc-800 text-zinc-200'
                : 'text-zinc-400 hover:text-zinc-300 hover:bg-zinc-800/50',
            )}
          >
            <div className="truncate">{seg.label}</div>
            <div className="flex gap-1 mt-0.5">
              <span className={cn(
                'text-[10px] px-1 rounded',
                seg.type === 'logic' ? 'bg-yellow-900/50 text-yellow-400' : 'bg-zinc-700 text-zinc-500',
              )}>
                {seg.type}
              </span>
              <span className="text-[10px] px-1 rounded bg-zinc-700 text-zinc-500">
                {seg.role}
              </span>
              <span className="text-[10px] text-zinc-600">
                {seg.tokenCount}t
              </span>
            </div>
          </button>
        ))}
      </div>

      {/* Editor */}
      <div className="flex-1">
        {selected ? (
          <SegmentEditForm segment={selected} onSave={handleSegmentUpdate} />
        ) : (
          <div className="flex items-center justify-center h-full text-zinc-600">
            选择一个片段开始编辑
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// SegmentEditForm
// ============================================================================

function SegmentEditForm({ segment, onSave }: {
  segment: PromptSegment;
  onSave: (seg: PromptSegment) => void;
}) {
  const [label, setLabel] = useState(segment.label);
  const [content, setContent] = useState(segment.content);
  const [type, setType] = useState<SegmentType>(segment.type);
  const [role, setRole] = useState<SegmentRole>(segment.role);
  const [priority, setPriority] = useState(segment.priority);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashFilter, setSlashFilter] = useState('');
  const [slashPos, setSlashPos] = useState({ top: 0, left: 0 });
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Reset form when segment changes
  useEffect(() => {
    setLabel(segment.label);
    setContent(segment.content);
    setType(segment.type);
    setRole(segment.role);
    setPriority(segment.priority);
  }, [segment.id, segment.label, segment.content, segment.type, segment.role, segment.priority]);

  const handleContentChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setContent(value);

    // Detect '/' for slash command menu
    const cursorPos = e.target.selectionStart;
    const textBefore = value.slice(0, cursorPos);
    const lastSlash = textBefore.lastIndexOf('/');

    if (lastSlash >= 0 && (lastSlash === 0 || textBefore[lastSlash - 1] === '\n' || textBefore[lastSlash - 1] === ' ')) {
      const query = textBefore.slice(lastSlash + 1);
      if (!query.includes(' ') && !query.includes('\n')) {
        setSlashFilter(query);
        setShowSlashMenu(true);
        // Position menu near cursor (simplified)
        setSlashPos({ top: 24, left: 0 });
        return;
      }
    }
    setShowSlashMenu(false);
  }, []);

  const insertToolReference = useCallback((toolId: string) => {
    if (!textareaRef.current) return;
    const ta = textareaRef.current;
    const cursorPos = ta.selectionStart;
    const textBefore = content.slice(0, cursorPos);
    const lastSlash = textBefore.lastIndexOf('/');
    const textAfter = content.slice(cursorPos);

    const reference = `{{tool:${toolId}}}`;
    const newContent = textBefore.slice(0, lastSlash) + reference + textAfter;
    setContent(newContent);
    setShowSlashMenu(false);

    // Restore cursor position
    requestAnimationFrame(() => {
      const newPos = lastSlash + reference.length;
      ta.setSelectionRange(newPos, newPos);
      ta.focus();
    });
  }, [content]);

  const handleSave = useCallback(() => {
    onSave({
      ...segment,
      label,
      content,
      type,
      role,
      priority,
      tokenCount: Math.ceil(content.length / 4),
    });
  }, [segment, label, content, type, role, priority, onSave]);

  const filteredTools = TOOL_REFERENCES.filter(
    (t) => t.id.includes(slashFilter) || t.label.includes(slashFilter),
  );

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex-none px-4 py-3 border-b border-zinc-800 space-y-3">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="w-full bg-transparent text-zinc-200 text-sm font-medium focus:outline-none"
        />
        <div className="flex gap-3">
          <Select label="类型" value={type} onChange={(v) => setType(v as SegmentType)}
            options={[['content', '内容'], ['logic', '逻辑']]} />
          <Select label="角色" value={role} onChange={(v) => setRole(v as SegmentRole)}
            options={[['system', 'System'], ['context', 'Context'], ['draft', 'Draft']]} />
          <div>
            <span className="text-[10px] text-zinc-500 mr-1">优先级</span>
            <input
              type="number"
              value={priority}
              onChange={(e) => setPriority(Number(e.target.value))}
              className="w-12 bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-xs text-zinc-200"
            />
          </div>
        </div>
      </div>

      {/* Content editor */}
      <div className="flex-1 relative">
        <textarea
          ref={textareaRef}
          value={content}
          onChange={handleContentChange}
          className="w-full h-full bg-zinc-950 text-zinc-200 text-sm p-4 resize-none focus:outline-none font-mono leading-relaxed"
          placeholder="输入 Prompt 内容... 键入 / 引用工具"
        />

        {/* Slash command menu */}
        {showSlashMenu && filteredTools.length > 0 && (
          <div
            className="absolute bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl py-1 z-10 w-64"
            style={{ top: slashPos.top, left: slashPos.left + 16 }}
          >
            {filteredTools.map((tool) => (
              <button
                key={tool.id}
                onClick={() => insertToolReference(tool.id)}
                className="w-full text-left px-3 py-1.5 text-sm hover:bg-zinc-700 transition-colors"
              >
                <span className="text-zinc-200">{tool.label}</span>
                <span className="text-zinc-500 ml-2 text-xs font-mono">{tool.description}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex-none px-4 py-2 border-t border-zinc-800 flex items-center justify-between">
        <span className="text-xs text-zinc-600">
          {Math.ceil(content.length / 4)} tokens | {segment.sourceDoc}
        </span>
        <button
          onClick={handleSave}
          className="px-3 py-1 bg-blue-600 text-white rounded text-xs hover:bg-blue-500"
        >
          保存
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// Shared
// ============================================================================

function Select({ label, value, onChange, options }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <div>
      <span className="text-[10px] text-zinc-500 mr-1">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-xs text-zinc-200"
      >
        {options.map(([val, lab]) => (
          <option key={val} value={val}>{lab}</option>
        ))}
      </select>
    </div>
  );
}
