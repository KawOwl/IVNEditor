/**
 * InputPanel — 玩家输入面板
 *
 * 输入模式：
 *   - freetext: 自由文本输入 + 动作类型按钮（思考/对话/行动/观察）
 *   - choice: 显示选项按钮 + 自由文本输入
 *     玩家可以点击选项，也可以忽略选项直接输入自由文本
 *
 * 输入时显示 prompt_hint（来自 signal_input_needed），无 hint 时显示默认提示。
 * 仅在 waiting-input 状态时可用。
 */

import { useState, useCallback, type KeyboardEvent } from 'react';
import { useGameStore } from '../stores/game-store';
import { cn } from '../lib/utils';

// ============================================================================
// Action types
// ============================================================================

interface ActionType {
  id: string;
  label: string;
  icon: string;
  prefix: string;    // 发给 LLM 的前缀标记
  color: string;      // button active color class
}

const ACTION_TYPES: ActionType[] = [
  { id: 'think',   label: '思考', icon: '💭', prefix: '[思考]', color: 'border-purple-600 text-purple-300 bg-purple-950/40' },
  { id: 'speak',   label: '对话', icon: '💬', prefix: '[对话]', color: 'border-blue-600 text-blue-300 bg-blue-950/40' },
  { id: 'act',     label: '行动', icon: '🎬', prefix: '[行动]', color: 'border-emerald-600 text-emerald-300 bg-emerald-950/40' },
  { id: 'observe', label: '观察', icon: '👁', prefix: '[观察]', color: 'border-amber-600 text-amber-300 bg-amber-950/40' },
];

const DEFAULT_HINT = '你想做什么？';

// ============================================================================
// InputPanel
// ============================================================================

export interface InputPanelProps {
  onSubmit: (text: string) => void;
}

export function InputPanel({ onSubmit }: InputPanelProps) {
  const status = useGameStore((s) => s.status);
  const inputHint = useGameStore((s) => s.inputHint);
  const inputType = useGameStore((s) => s.inputType);
  const choices = useGameStore((s) => s.choices);
  const [text, setText] = useState('');
  const [activeAction, setActiveAction] = useState<string>('act');

  const isDisabled = status !== 'waiting-input';
  const hasChoices = inputType === 'choice' && choices && choices.length > 0;
  const currentAction = ACTION_TYPES.find((a) => a.id === activeAction) ?? ACTION_TYPES[2]!;

  const handleSubmit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || isDisabled) return;
    // 拼接动作前缀：[行动] 走向那扇门
    onSubmit(`${currentAction.prefix} ${trimmed}`);
    setText('');
  }, [text, isDisabled, onSubmit, currentAction]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  const handleChoice = useCallback(
    (choice: string) => {
      if (isDisabled) return;
      onSubmit(choice);
    },
    [isDisabled, onSubmit],
  );

  const displayHint = inputHint ?? DEFAULT_HINT;

  return (
    <div className="border-t border-zinc-800 px-4 py-3 space-y-2.5">
      {/* Hint */}
      {status === 'waiting-input' && (
        <div className="text-sm text-zinc-400 italic">
          {displayHint}
        </div>
      )}

      {/* Choice buttons */}
      {hasChoices && (
        <div className="flex flex-wrap gap-2">
          {choices!.map((choice, i) => (
            <button
              key={i}
              onClick={() => handleChoice(choice)}
              disabled={isDisabled}
              className={cn(
                'px-4 py-2 rounded-lg text-sm transition-colors border',
                isDisabled
                  ? 'bg-zinc-900 border-zinc-800 text-zinc-600 cursor-not-allowed'
                  : 'bg-zinc-900 border-zinc-700 text-zinc-200 hover:bg-zinc-800 hover:border-zinc-600 hover:text-white cursor-pointer',
              )}
            >
              {choice}
            </button>
          ))}
        </div>
      )}

      {/* Text input */}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={isDisabled}
        placeholder={
          isDisabled
            ? '等待生成...'
            : hasChoices
              ? '或者输入自定义回应...'
              : `${currentAction.icon} ${currentAction.label}...`
        }
        rows={2}
        className={cn(
          'w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2',
          'text-zinc-100 placeholder:text-zinc-600 resize-none text-sm',
          'focus:outline-none focus:border-zinc-500 transition-colors',
          isDisabled && 'opacity-50 cursor-not-allowed',
        )}
      />

      {/* Action type buttons row (below input) */}
      <div className="flex items-center gap-1.5">
        {ACTION_TYPES.map((action) => (
          <button
            key={action.id}
            onClick={() => {
              setActiveAction(action.id);
              // 如果有文字，直接以该动作类型发送
              const trimmed = text.trim();
              if (trimmed && !isDisabled) {
                onSubmit(`${action.prefix} ${trimmed}`);
                setText('');
              }
            }}
            disabled={isDisabled}
            className={cn(
              'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border',
              isDisabled
                ? 'bg-zinc-900 border-zinc-800 text-zinc-600 cursor-not-allowed'
                : activeAction === action.id
                  ? action.color
                  : 'bg-zinc-900/50 border-zinc-800 text-zinc-500 hover:text-zinc-400 hover:border-zinc-700 cursor-pointer',
            )}
          >
            {action.icon} {action.label}
          </button>
        ))}

        <div className="flex-1" />

        {/* Enter 快捷键提示 */}
        {!isDisabled && text.trim() && (
          <span className="text-[10px] text-zinc-600">
            Enter 发送 ({currentAction.label})
          </span>
        )}
      </div>

      {/* Status indicator */}
      {status === 'generating' && (
        <div className="text-xs text-zinc-500 animate-pulse">
          正在生成...
        </div>
      )}
      {status === 'error' && (
        <div className="text-xs text-red-400">
          发生错误，请查看调试面板
        </div>
      )}
    </div>
  );
}
