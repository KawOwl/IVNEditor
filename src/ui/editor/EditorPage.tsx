/**
 * EditorPage — 编剧编辑器页面
 *
 * 左右分栏布局：
 *   - 左侧：CodeMirror 6 编辑器
 *   - 右侧：预览面板（大纲、工具引用、Token 统计）
 */

import { useState, useCallback, useMemo } from 'react';
import { useAppStore } from '../../stores/app-store';
import { CodeEditor } from './CodeEditor';
import type { StateVarInfo } from '../../core/editor/completion-sources';

const SAMPLE_CONTENT = `# GM Prompt — 序章第一章

## 阶段1：苏醒

### 场景设定
玩家在一个昏暗的地下设施中苏醒。空气中弥漫着消毒水的气味。

### GM 行为指令
- 描述环境时使用感官细节（视觉、听觉、触觉、嗅觉）
- 不要直接告诉玩家该做什么，让玩家自主探索
- 使用 {{tool:update_state}} 更新玩家位置
- 使用 {{tool:signal_input_needed}} 在关键决策点等待玩家输入

### 状态变量
当前阶段：{{state:stage}}
当前位置：{{state:current_location}}

## 阶段2：行走

### 核心体验
玩家开始探索设施，发现环境中的线索。

### 收束协议
当偏离度达到阈值时，使用 {{tool:update_state}} 触发收束。
`;

export function EditorPage() {
  const goHome = useAppStore((s) => s.goHome);
  const [content, setContent] = useState(SAMPLE_CONTENT);

  const handleContentChange = useCallback((newContent: string) => {
    setContent(newContent);
  }, []);

  // Sample state vars for autocomplete (will be dynamic in future)
  const stateVars = useMemo<StateVarInfo[]>(() => [
    { name: 'chapter', type: 'number', description: '当前章节' },
    { name: 'stage', type: 'number', description: '当前阶段序号' },
    { name: 'stage_core_experience', type: 'boolean', description: '核心体验是否已建立' },
    { name: 'turn_count_in_stage', type: 'number', description: '当前阶段轮次计数' },
    { name: 'deviation_layers', type: 'number', description: '连续偏离层数' },
    { name: 'relationship_stage', type: 'number', description: '关系阶段' },
    { name: 'girl_communication_level', type: 'number', description: '女孩交流能力' },
    { name: 'current_location', type: 'string', description: '当前位置' },
    { name: 'explored_locations', type: 'array', description: '已探索区域' },
    { name: 'sleep_count', type: 'number', description: '入睡次数' },
  ], []);

  return (
    <div className="h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      {/* Header */}
      <header className="flex-none px-6 py-3 border-b border-zinc-800 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={goHome}
            className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            ← 返回
          </button>
          <h1 className="text-sm font-medium text-zinc-300">编剧编辑器</h1>
        </div>
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span>{content.length} 字符</span>
          <span className="text-zinc-700">|</span>
          <span>~{Math.round(content.length / 4).toLocaleString()} tokens</span>
        </div>
      </header>

      {/* Main content — left/right split */}
      <div className="flex-1 flex min-h-0">
        {/* Left: Editor */}
        <div className="flex-1 min-w-0 border-r border-zinc-800">
          <CodeEditor
            value={content}
            onChange={handleContentChange}
            stateVars={stateVars}
          />
        </div>

        {/* Right: Preview */}
        <div className="w-80 flex-none overflow-y-auto bg-zinc-950">
          <PreviewPanel content={content} />
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Preview Panel — 右侧预览
// ============================================================================

function PreviewPanel({ content }: { content: string }) {
  const outline = extractOutline(content);
  const toolRefs = extractToolRefs(content);
  const stateRefs = extractStateRefs(content);

  return (
    <div className="p-4 space-y-6">
      {/* Outline */}
      <section>
        <h3 className="text-xs font-medium text-zinc-400 mb-2 uppercase tracking-wider">
          文档大纲
        </h3>
        {outline.length === 0 ? (
          <p className="text-xs text-zinc-600">无标题</p>
        ) : (
          <ul className="space-y-1">
            {outline.map((item, i) => (
              <li
                key={i}
                className="text-xs text-zinc-400 hover:text-zinc-200 cursor-default"
                style={{ paddingLeft: `${(item.level - 1) * 12}px` }}
              >
                <span className="text-zinc-600 mr-1">{'#'.repeat(item.level)}</span>
                {item.text}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Tool References */}
      <section>
        <h3 className="text-xs font-medium text-zinc-400 mb-2 uppercase tracking-wider">
          工具引用
        </h3>
        {toolRefs.length === 0 ? (
          <p className="text-xs text-zinc-600">无工具引用</p>
        ) : (
          <ul className="space-y-1">
            {toolRefs.map((ref) => (
              <li key={ref.name} className="flex items-center justify-between text-xs">
                <span className="text-blue-400 font-mono">{ref.name}</span>
                <span className="text-zinc-600">{ref.count}x</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* State References */}
      <section>
        <h3 className="text-xs font-medium text-zinc-400 mb-2 uppercase tracking-wider">
          状态变量引用
        </h3>
        {stateRefs.length === 0 ? (
          <p className="text-xs text-zinc-600">无状态变量引用</p>
        ) : (
          <ul className="space-y-1">
            {stateRefs.map((ref) => (
              <li key={ref.name} className="flex items-center justify-between text-xs">
                <span className="text-green-400 font-mono">{ref.name}</span>
                <span className="text-zinc-600">{ref.count}x</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Token Stats */}
      <section>
        <h3 className="text-xs font-medium text-zinc-400 mb-2 uppercase tracking-wider">
          Token 统计
        </h3>
        <div className="text-xs text-zinc-400 space-y-1">
          <div className="flex justify-between">
            <span>字符数</span>
            <span className="text-zinc-300">{content.length.toLocaleString()}</span>
          </div>
          <div className="flex justify-between">
            <span>估算 Tokens</span>
            <span className="text-zinc-300">~{Math.round(content.length / 4).toLocaleString()}</span>
          </div>
          <div className="flex justify-between">
            <span>行数</span>
            <span className="text-zinc-300">{content.split('\n').length}</span>
          </div>
        </div>
      </section>
    </div>
  );
}

// ============================================================================
// Parsing helpers
// ============================================================================

interface OutlineItem {
  level: number;
  text: string;
  line: number;
}

function extractOutline(content: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i]!.match(/^(#{1,6})\s+(.+)/);
    if (match) {
      items.push({
        level: match[1]!.length,
        text: match[2]!.trim(),
        line: i + 1,
      });
    }
  }
  return items;
}

interface RefCount {
  name: string;
  count: number;
}

function extractToolRefs(content: string): RefCount[] {
  const counts = new Map<string, number>();
  const re = /\{\{tool:(\w+)\}\}/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const name = m[1]!;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

function extractStateRefs(content: string): RefCount[] {
  const counts = new Map<string, number>();
  const re = /\{\{state:(\w+)\}\}/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const name = m[1]!;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}
