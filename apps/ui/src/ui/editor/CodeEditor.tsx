/**
 * CodeEditor — CodeMirror 6 React 封装
 *
 * 编剧用的 Markdown 编辑器，支持：
 *   - Markdown 语法高亮
 *   - 暗色主题（匹配项目 zinc 色调）
 *   - 受控 value + onChange
 */

import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { autocompletion } from '@codemirror/autocomplete';
import { oneDark } from '@codemirror/theme-one-dark';
import { scriptTagDecorations } from '@/lib/editor/decorations';
import { createStateCompletionSource } from '@/lib/editor/completion-sources';
import type { StateVarInfo } from '@/lib/editor/completion-sources';

export interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  stateVars?: StateVarInfo[];
}

export function CodeEditor({ value, onChange, className, stateVars = [] }: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const stateVarsRef = useRef(stateVars);
  stateVarsRef.current = stateVars;

  // Create editor on mount
  useEffect(() => {
    if (!containerRef.current) return;

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onChangeRef.current(update.state.doc.toString());
      }
    });

    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        drawSelection(),
        bracketMatching(),
        history(),
        highlightSelectionMatches(),
        markdown(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        oneDark,
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
        ]),
        updateListener,
        autocompletion({
          override: [
            createStateCompletionSource(() => stateVarsRef.current),
          ],
          activateOnTyping: true,
        }),
        scriptTagDecorations(),
        // Editor styling
        EditorView.theme({
          '&': {
            height: '100%',
            fontSize: '14px',
          },
          '.cm-scroller': {
            fontFamily: '"Geist Mono", "SF Mono", "Fira Code", monospace',
            lineHeight: '1.6',
          },
          '.cm-content': {
            padding: '16px 0',
          },
          '.cm-gutters': {
            backgroundColor: 'transparent',
            borderRight: '1px solid #27272a',
          },
          '.cm-lineNumbers .cm-gutterElement': {
            color: '#52525b',
            padding: '0 12px 0 8px',
          },
          '.cm-activeLine': {
            backgroundColor: '#18181b80',
          },
          '.cm-activeLineGutter': {
            backgroundColor: 'transparent',
          },
        }),
        EditorView.lineWrapping,
      ],
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps — only mount once
  }, []);

  // Sync external value changes (but don't loop back our own changes)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    const currentValue = view.state.doc.toString();
    if (currentValue !== value) {
      view.dispatch({
        changes: { from: 0, to: currentValue.length, insert: value },
      });
    }
  }, [value]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ height: '100%', overflow: 'hidden' }}
    />
  );
}
