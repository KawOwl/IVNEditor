/**
 * InputPanel — 玩家输入面板
 *
 * 交互流程：
 *   1. 输入框自由输入（观察、对话、思考可以混合在一条消息里）
 *   2. Enter 发送，Shift+Enter 换行
 *   3. choice 模式下额外显示选项按钮，点击直接发送
 */

import { useState, useCallback, type KeyboardEvent } from 'react';
import { useGameStore } from '../stores/game-store';
import { cn } from '../lib/utils';

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

  const isDisabled = status !== 'waiting-input';
  const hasChoices = inputType === 'choice' && choices && choices.length > 0;
  const hasText = text.trim().length > 0;

  const handleSubmit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || isDisabled) return;
    onSubmit(trimmed);
    setText('');
  }, [text, isDisabled, onSubmit]);

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
    <div className="border-t border-zinc-800 px-4 py-3 space-y-2">
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
                'px-4 py-2 rounded text-sm transition-colors border',
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

      {/* Text input with inline send button */}
      <div className={cn(
        'relative bg-zinc-900 border border-zinc-700 rounded-lg overflow-hidden transition-colors',
        !isDisabled && 'focus-within:border-zinc-500',
        isDisabled && 'opacity-50',
      )}>
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
                : '输入你的行动、对话或想法...'
          }
          rows={2}
          className={cn(
            'w-full bg-transparent px-3 py-2 pr-12',
            'text-zinc-100 placeholder:text-zinc-600 resize-none text-sm',
            'focus:outline-none',
            isDisabled && 'cursor-not-allowed',
          )}
        />
        <button
          onClick={handleSubmit}
          disabled={isDisabled || !hasText}
          className={cn(
            'absolute right-2 bottom-2 w-7 h-7 rounded-md flex items-center justify-center transition-colors',
            isDisabled || !hasText
              ? 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
              : 'bg-emerald-600 text-white hover:bg-emerald-500 cursor-pointer',
          )}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
      </div>
    </div>
  );
}
