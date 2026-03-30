/**
 * InputPanel — 玩家输入面板
 *
 * 支持两种输入模式：
 *   - freetext: 自由文本输入
 *   - choice: 选项选择
 *
 * 输入时显示 prompt_hint（来自 signal_input_needed）。
 * 仅在 waiting-input 状态时可用。
 */

import { useState, useCallback, type KeyboardEvent } from 'react';
import { useGameStore } from '../stores/game-store';
import { cn } from '../lib/utils';

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

  return (
    <div className="border-t border-zinc-800 px-6 py-4">
      {/* Hint */}
      {inputHint && status === 'waiting-input' && (
        <div className="text-sm text-zinc-400 mb-2 italic">
          {inputHint}
        </div>
      )}

      {/* Choice mode */}
      {inputType === 'choice' && choices && choices.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {choices.map((choice, i) => (
            <button
              key={i}
              onClick={() => handleChoice(choice)}
              disabled={isDisabled}
              className={cn(
                'px-4 py-2 rounded-lg text-sm transition-colors',
                isDisabled
                  ? 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
                  : 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700 hover:text-white cursor-pointer',
              )}
            >
              {choice}
            </button>
          ))}
        </div>
      ) : (
        /* Freetext mode */
        <div className="flex gap-3 items-end">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isDisabled}
            placeholder={isDisabled ? '等待 GM...' : '输入你的行动、对话或想法...'}
            rows={2}
            className={cn(
              'flex-1 bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-2',
              'text-zinc-100 placeholder:text-zinc-600 resize-none',
              'focus:outline-none focus:border-zinc-500 transition-colors',
              isDisabled && 'opacity-50 cursor-not-allowed',
            )}
          />
          <button
            onClick={handleSubmit}
            disabled={isDisabled || !text.trim()}
            className={cn(
              'px-4 py-2 rounded-lg text-sm font-medium transition-colors',
              isDisabled || !text.trim()
                ? 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
                : 'bg-blue-600 text-white hover:bg-blue-500 cursor-pointer',
            )}
          >
            发送
          </button>
        </div>
      )}

      {/* Status indicator */}
      {status === 'generating' && (
        <div className="text-xs text-zinc-500 mt-2 animate-pulse">
          GM 正在生成...
        </div>
      )}
      {status === 'error' && (
        <div className="text-xs text-red-400 mt-2">
          发生错误，请查看调试面板
        </div>
      )}
    </div>
  );
}
