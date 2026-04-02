/**
 * InputPanel — 玩家输入面板
 *
 * 交互模式：
 *   1. 在输入框输入内容
 *   2. 点击下方动作按钮（思考/对话/行动/观察）发送
 *      - 无文本时按钮为灰色标签态，仅切换默认类型
 *      - 有文本时按钮高亮为发送态，点击直接发送
 *      - Enter 快捷键以当前选中类型发送
 *   3. choice 模式下额外显示选项按钮，点击直接发送
 *
 * placeholder 随动作类型变化，引导用户输入。
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
  prefix: string;
  placeholder: string;  // 输入框引导文字
  // 标签态（无文本）
  tagColor: string;
  // 发送态（有文本）
  sendColor: string;
}

const ACTION_TYPES: ActionType[] = [
  {
    id: 'think', label: '思考', icon: '💭', prefix: '[思考]',
    placeholder: '你在想什么...',
    tagColor: 'border-purple-800/50 text-purple-500/70',
    sendColor: 'border-purple-500 text-purple-200 bg-purple-900/60 shadow-sm shadow-purple-900/30',
  },
  {
    id: 'speak', label: '对话', icon: '💬', prefix: '[对话]',
    placeholder: '你想说什么...',
    tagColor: 'border-blue-800/50 text-blue-500/70',
    sendColor: 'border-blue-500 text-blue-200 bg-blue-900/60 shadow-sm shadow-blue-900/30',
  },
  {
    id: 'act', label: '行动', icon: '🎬', prefix: '[行动]',
    placeholder: '你想做什么...',
    tagColor: 'border-emerald-800/50 text-emerald-500/70',
    sendColor: 'border-emerald-500 text-emerald-200 bg-emerald-900/60 shadow-sm shadow-emerald-900/30',
  },
  {
    id: 'observe', label: '观察', icon: '👁', prefix: '[观察]',
    placeholder: '你想观察什么...',
    tagColor: 'border-amber-800/50 text-amber-500/70',
    sendColor: 'border-amber-500 text-amber-200 bg-amber-900/60 shadow-sm shadow-amber-900/30',
  },
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
  const hasText = text.trim().length > 0;
  const currentAction = ACTION_TYPES.find((a) => a.id === activeAction) ?? ACTION_TYPES[2]!;

  const submitWithAction = useCallback((action: ActionType) => {
    const trimmed = text.trim();
    if (!trimmed || isDisabled) return;
    onSubmit(`${action.prefix} ${trimmed}`);
    setText('');
  }, [text, isDisabled, onSubmit]);

  const handleSubmit = useCallback(() => {
    submitWithAction(currentAction);
  }, [submitWithAction, currentAction]);

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
              : currentAction.placeholder
        }
        rows={2}
        className={cn(
          'w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2',
          'text-zinc-100 placeholder:text-zinc-600 resize-none text-sm',
          'focus:outline-none focus:border-zinc-500 transition-colors',
          isDisabled && 'opacity-50 cursor-not-allowed',
        )}
      />

      {/* Action buttons row */}
      <div className="flex items-center gap-1.5">
        {ACTION_TYPES.map((action) => {
          const isActive = activeAction === action.id;
          return (
            <button
              key={action.id}
              onClick={() => {
                setActiveAction(action.id);
                if (hasText && !isDisabled) {
                  submitWithAction(action);
                }
              }}
              disabled={isDisabled}
              className={cn(
                'px-3 py-1.5 rounded-lg text-xs font-medium transition-all border',
                isDisabled
                  ? 'bg-zinc-900 border-zinc-800 text-zinc-600 cursor-not-allowed'
                  : hasText
                    // 发送态：高亮、有存在感
                    ? cn(
                        action.sendColor,
                        'cursor-pointer hover:brightness-110',
                      )
                    // 标签态：低调
                    : isActive
                      ? cn(action.tagColor, 'bg-zinc-900/50')
                      : 'border-zinc-800/50 text-zinc-600 bg-transparent hover:text-zinc-500 hover:border-zinc-700 cursor-pointer',
              )}
            >
              {action.icon} {action.label}{hasText && !isDisabled ? ' →' : ''}
            </button>
          );
        })}

        <div className="flex-1" />

        {/* 快捷键提示 */}
        {!isDisabled && hasText && (
          <span className="text-[10px] text-zinc-600">
            Enter = {currentAction.icon}{currentAction.label}
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
