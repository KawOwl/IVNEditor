/**
 * InputPanel — 玩家输入面板
 *
 * 交互流程：
 *   1. 在输入框输入内容（placeholder 引导："输入你想做的行动并提交"）
 *   2. 点击下方四个动作按钮之一发送（思考/对话/行动/观察）
 *      - 无文本时按钮灰色 disabled
 *      - 有文本时按钮亮起可点击
 *      - Enter 快捷键以当前选中类型发送
 *   3. choice 模式下额外显示选项按钮，点击直接发送
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
  prefix: string;
  color: string;        // active/enabled color
}

const ACTION_TYPES: ActionType[] = [
  { id: 'think',   label: '思考', prefix: '[思考]', color: 'border-purple-500 text-purple-200 bg-purple-900/50' },
  { id: 'speak',   label: '对话', prefix: '[对话]', color: 'border-blue-500 text-blue-200 bg-blue-900/50' },
  { id: 'act',     label: '行动', prefix: '[行动]', color: 'border-emerald-500 text-emerald-200 bg-emerald-900/50' },
  { id: 'observe', label: '观察', prefix: '[观察]', color: 'border-amber-500 text-amber-200 bg-amber-900/50' },
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
  const streamingText = useGameStore((s) => s.streamingText);
  const [text, setText] = useState('');
  const [activeAction, setActiveAction] = useState<string>('act');

  // 打字机还在播放中：streamingText 不为空 = 有未 finalize 的流式内容
  const typewriterPlaying = streamingText.length > 0;
  const isDisabled = status !== 'waiting-input' || typewriterPlaying;
  const hasChoices = inputType === 'choice' && choices && choices.length > 0 && !typewriterPlaying;
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
    <div className="border-t border-zinc-800 px-4 py-3 space-y-2">
      {/* Hint — 打字机播完后才显示 */}
      {status === 'waiting-input' && !typewriterPlaying && (
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
              : '输入你想做的事情，并点击对应行动类型提交'
        }
        rows={2}
        className={cn(
          'w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-2',
          'text-zinc-100 placeholder:text-zinc-600 resize-none text-sm',
          'focus:outline-none focus:border-zinc-500 transition-colors',
          isDisabled && 'opacity-50 cursor-not-allowed',
        )}
      />

      {/* Action buttons — 四等分宽度 */}
      <div className="grid grid-cols-4 gap-1.5">
        {ACTION_TYPES.map((action) => {
          const canSend = hasText && !isDisabled;
          return (
            <button
              key={action.id}
              onClick={() => {
                setActiveAction(action.id);
                if (canSend) {
                  submitWithAction(action);
                }
              }}
              disabled={isDisabled || !hasText}
              className={cn(
                'py-1.5 rounded text-xs font-medium transition-all border text-center',
                !canSend
                  ? 'bg-zinc-900/50 border-zinc-800 text-zinc-600 cursor-not-allowed'
                  : action.color + ' cursor-pointer hover:brightness-110',
              )}
            >
              {action.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
