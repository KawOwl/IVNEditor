/**
 * ChatInput - LLM-style chat input component for player interaction.
 *
 * Features:
 * - Text input + Send button (Enter to submit)
 * - Mode toggle: autonomous / intervention
 * - Auto-pause checkbox: pause after GOAP task completion
 * - Scrollable chat history showing player, narrator, character messages
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { usePlayerStore } from './player-store';
import type { ChatMessage } from './player-store';

interface ChatInputProps {
  onSendMessage: (message: string) => void;
  isRunning: boolean;
}

export function ChatInput({ onSendMessage, isRunning }: ChatInputProps) {
  const [inputValue, setInputValue] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);

  const mode = usePlayerStore((s) => s.mode);
  const autoPause = usePlayerStore((s) => s.autoPauseOnTaskDone);
  const dynamicGoap = usePlayerStore((s) => s.dynamicGoapEnabled);
  const chatHistory = usePlayerStore((s) => s.chatHistory);
  const setMode = usePlayerStore((s) => s.setMode);
  const toggleAutoPause = usePlayerStore((s) => s.toggleAutoPause);
  const toggleDynamicGoap = usePlayerStore((s) => s.toggleDynamicGoap);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatHistory.length]);

  const handleSubmit = useCallback(() => {
    const trimmed = inputValue.trim();
    if (!trimmed) return;
    onSendMessage(trimmed);
    setInputValue('');
  }, [inputValue, onSendMessage]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  return (
    <div style={styles.container}>
      {/* Chat history */}
      {chatHistory.length > 0 && (
        <div style={styles.chatHistory}>
          {chatHistory.slice(-30).map((msg) => (
            <ChatBubble key={msg.id} message={msg} />
          ))}
          <div ref={chatEndRef} />
        </div>
      )}

      {/* Input area */}
      <div style={styles.inputRow}>
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            !isRunning
              ? '点击"开始游戏"后可以输入...'
              : mode === 'intervention'
                ? '输入指令或对话，影响角色决策...'
                : '切换到介入模式后可输入（当前自主运行中）'
          }
          disabled={!isRunning}
          style={{
            ...styles.input,
            opacity: isRunning ? 1 : 0.5,
          }}
        />
        <button
          onClick={handleSubmit}
          disabled={!isRunning || !inputValue.trim()}
          style={{
            ...styles.sendBtn,
            opacity: isRunning && inputValue.trim() ? 1 : 0.4,
          }}
        >
          发送
        </button>
      </div>

      {/* Controls row */}
      {isRunning && (
        <div style={styles.controlsRow}>
          <div style={styles.modeGroup}>
            <button
              style={{
                ...styles.modeBtn,
                ...(mode === 'autonomous' ? styles.modeBtnActive : {}),
              }}
              onClick={() => setMode('autonomous')}
            >
              自主运行
            </button>
            <button
              style={{
                ...styles.modeBtn,
                ...(mode === 'intervention' ? styles.modeBtnIntervention : {}),
              }}
              onClick={() => setMode('intervention')}
            >
              介入模式
            </button>
          </div>

          <label style={styles.checkboxLabel}>
            <input
              type="checkbox"
              checked={autoPause}
              onChange={toggleAutoPause}
              style={styles.checkbox}
            />
            <span style={styles.checkboxText}>世界事件结束后等待介入</span>
          </label>
          <label style={styles.checkboxLabel}>
            <input
              type="checkbox"
              checked={dynamicGoap}
              onChange={toggleDynamicGoap}
              style={styles.checkbox}
            />
            <span style={styles.checkboxText}>允许根据角色行动习得新动作</span>
          </label>
        </div>
      )}
    </div>
  );
}

// ─── ChatBubble sub-component ──────────────────────────

function ChatBubble({ message }: { message: ChatMessage }) {
  const roleStyles: Record<string, React.CSSProperties> = {
    player: { color: '#7ec8e3', fontWeight: 'bold' },
    narrator: { color: '#b8b8b8', fontStyle: 'italic' },
    character: { color: '#e6c3a1' },
    system: { color: '#666', fontSize: '11px' },
  };

  const roleLabels: Record<string, string> = {
    player: '你',
    narrator: '',
    character: '',
    system: '',
  };

  const label = roleLabels[message.role];

  return (
    <div style={styles.bubble}>
      {label && <span style={roleStyles[message.role]}>{label}：</span>}
      <span style={roleStyles[message.role] || {}}>
        {message.content}
      </span>
    </div>
  );
}

// ─── Styles ────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    background: 'rgba(15, 15, 26, 0.95)',
    borderTop: '1px solid rgba(255,255,255,0.1)',
    padding: '0',
  },
  chatHistory: {
    maxHeight: '120px',
    overflowY: 'auto',
    padding: '8px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  bubble: {
    fontSize: '12px',
    lineHeight: '1.5',
    wordBreak: 'break-word' as const,
  },
  inputRow: {
    display: 'flex',
    gap: '6px',
    padding: '8px 12px',
  },
  input: {
    flex: 1,
    padding: '8px 12px',
    background: 'rgba(255,255,255,0.06)',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'rgba(255,255,255,0.15)',
    borderRadius: '8px',
    color: '#e0e0e0',
    fontSize: '13px',
    outline: 'none',
    fontFamily: 'inherit',
  },
  sendBtn: {
    padding: '8px 16px',
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    borderWidth: '0',
    borderStyle: 'none',
    borderRadius: '8px',
    color: 'white',
    fontSize: '13px',
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
  },
  controlsRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '4px 12px 8px',
    gap: '8px',
  },
  modeGroup: {
    display: 'flex',
    gap: '4px',
  },
  modeBtn: {
    padding: '3px 10px',
    background: 'rgba(255,255,255,0.06)',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: '4px',
    color: '#888',
    fontSize: '11px',
    cursor: 'pointer',
  },
  modeBtnActive: {
    background: 'rgba(102, 126, 234, 0.25)',
    borderColor: '#667eea',
    color: '#7ec8e3',
  },
  modeBtnIntervention: {
    background: 'rgba(230, 195, 161, 0.2)',
    borderColor: '#e6c3a1',
    color: '#e6c3a1',
  },
  checkboxLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    cursor: 'pointer',
  },
  checkbox: {
    accentColor: '#667eea',
  },
  checkboxText: {
    color: '#888',
    fontSize: '11px',
  },
};
