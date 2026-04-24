/**
 * DiffEditor — CodeMirror 6 Merge View（只读 diff 对比）
 *
 * 使用 @codemirror/merge 的 MergeView 展示原文 vs 衍生版的差异。
 * 效果类似 git diff：行级高亮 + 行内变化部分标记。
 */

import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';
import { MergeView } from '@codemirror/merge';

export interface DiffEditorProps {
  original: string;
  modified: string;
  className?: string;
}

/** 共享的 CM 扩展（只读 + 暗色主题） */
function sharedExtensions() {
  return [
    lineNumbers(),
    markdown(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    oneDark,
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorView.theme({
      '&': { fontSize: '12px', height: '100%' },
      '.cm-scroller': {
        fontFamily: '"Geist Mono", "SF Mono", "Fira Code", monospace',
        lineHeight: '1.5',
        overflow: 'auto',
      },
      '.cm-gutters': {
        backgroundColor: 'transparent',
        borderRight: '1px solid #27272a',
      },
      '.cm-lineNumbers .cm-gutterElement': {
        color: '#52525b',
        padding: '0 8px 0 4px',
        fontSize: '10px',
      },
      // Merge view diff colors
      '.cm-mergeView .cm-changedLine': {
        backgroundColor: '#14532d20 !important',
      },
      '.cm-mergeView .cm-deletedChunk': {
        backgroundColor: '#7f1d1d30 !important',
      },
    }),
    EditorView.lineWrapping,
  ];
}

export function DiffEditor({ original, modified, className }: DiffEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mergeViewRef = useRef<MergeView | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const view = new MergeView({
      a: {
        doc: original,
        extensions: sharedExtensions(),
      },
      b: {
        doc: modified,
        extensions: sharedExtensions(),
      },
      parent: containerRef.current,
      collapseUnchanged: { margin: 3, minSize: 4 },
    });

    mergeViewRef.current = view;

    return () => {
      view.destroy();
      mergeViewRef.current = null;
    };
    // Recreate when content changes
  }, [original, modified]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ height: '100%', overflow: 'auto' }}
    />
  );
}
