/**
 * Game Renderer - React-based visual novel UI.
 * Scene queue: each scene is shown one-at-a-time with typewriter effect,
 * then auto-advances to the next after a brief pause.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import type { SceneOutput } from '../memory/schemas';
import { T } from '../theme';

interface GameRendererProps {
  scenes: SceneOutput[];
  characterName: string;
  currentTime: string;
  currentLocation: string;
}

function useTypewriter(text: string, speed: number = 50) {
  const [displayed, setDisplayed] = useState('');
  const [isComplete, setIsComplete] = useState(false);

  useEffect(() => {
    setDisplayed('');
    setIsComplete(false);
    if (!text) return;

    let index = 0;
    const timer = setInterval(() => {
      index++;
      setDisplayed(text.slice(0, index));
      if (index >= text.length) {
        clearInterval(timer);
        setIsComplete(true);
      }
    }, speed);

    return () => clearInterval(timer);
  }, [text, speed]);

  return { displayed, isComplete };
}

export function GameRenderer({
  scenes,
  characterName,
  currentTime,
  currentLocation,
}: GameRendererProps) {
  const [history, setHistory] = useState<SceneOutput[]>([]);
  const [queue, setQueue] = useState<SceneOutput[]>([]);
  const [currentScene, setCurrentScene] = useState<SceneOutput | null>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const lastScenesRef = useRef<SceneOutput[]>([]);

  // When new scenes arrive from core-loop, enqueue them
  useEffect(() => {
    if (scenes.length === 0 || scenes === lastScenesRef.current) return;
    lastScenesRef.current = scenes;
    setQueue((q) => [...q, ...scenes]);
  }, [scenes]);

  // Dequeue: when no scene is currently displayed, take the next from queue
  useEffect(() => {
    if (currentScene || queue.length === 0) return;
    const [next, ...rest] = queue;
    setCurrentScene(next);
    setQueue(rest);
  }, [currentScene, queue]);

  // Get display text for typewriter
  const displayText = currentScene
    ? (currentScene.dialogue || currentScene.narration || '')
    : '';
  const { displayed, isComplete } = useTypewriter(displayText, 40);

  // When typewriter completes, wait briefly then move scene to history
  useEffect(() => {
    if (!isComplete || !currentScene) return;
    const timer = setTimeout(() => {
      setHistory((h) => [...h, currentScene]);
      setCurrentScene(null);
    }, 1500);
    return () => clearTimeout(timer);
  }, [isComplete, currentScene]);

  // Auto-scroll history
  useEffect(() => {
    if (historyRef.current) {
      historyRef.current.scrollTop = historyRef.current.scrollHeight;
    }
  }, [history, displayed]);

  const emotionToEmoji: Record<string, string> = {
    neutral: '',
    happy: '😊',
    sad: '😢',
    angry: '😠',
    surprised: '😲',
    fearful: '😨',
    determined: '💪',
    suspicious: '🤨',
  };

  return (
    <div style={styles.container}>
      {/* Header bar */}
      <div style={styles.header}>
        <span style={styles.headerTime}>{currentTime}</span>
        <span style={styles.headerLocation}>{currentLocation}</span>
        <span style={styles.headerChar}>{characterName}</span>
      </div>

      {/* Scene background area */}
      <div style={styles.sceneArea}>
        {/* History scroll */}
        <div ref={historyRef} style={styles.history}>
          {history.map((h, i) => {
            const text = h.dialogue || h.narration || '';
            return (
              <div key={i} style={styles.historyEntry}>
                {h.narration && h.dialogue && (
                  <p style={styles.historyNarration}>{h.narration}</p>
                )}
                {h.speaker ? (
                  <p style={styles.historyDialogue}>
                    <span style={styles.speakerName}>{h.speaker}</span>
                    ：{text}
                  </p>
                ) : (
                  <p style={styles.historyNarration}>{text}</p>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Dialogue box — current scene with typewriter */}
      {currentScene && (
        <div style={styles.dialogueBox}>
          {currentScene.narration && currentScene.dialogue && (
            <p style={styles.narration}>{currentScene.narration}</p>
          )}
          <div style={styles.dialogueContent}>
            {currentScene.speaker && (
              <div style={styles.speakerTag}>
                {currentScene.speaker}
                {currentScene.emotion && (
                  <span style={styles.emotionBadge}>
                    {emotionToEmoji[currentScene.emotion] ?? ''} {currentScene.emotion}
                  </span>
                )}
              </div>
            )}
            <p style={styles.dialogueText}>
              {displayed}
              {!isComplete && <span style={styles.cursor}>▊</span>}
            </p>
          </div>
          {/* Queue indicator */}
          {queue.length > 0 && (
            <div style={styles.queueHint}>
              还有 {queue.length} 段...
            </div>
          )}
        </div>
      )}

      {/* Empty state when no scene and no queue */}
      {!currentScene && queue.length === 0 && history.length === 0 && (
        <div style={styles.dialogueBox}>
          <p style={styles.emptyHint}>等待叙事生成...</p>
        </div>
      )}
    </div>
  );
}

// ─── Inline styles ───────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    background: T.bg,
    color: T.textPrimary,
    fontFamily: T.fontSerif,
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '8px 16px',
    background: T.bgSurface,
    fontSize: '13px',
    color: T.textSecondary,
    flexShrink: 0,
    fontFamily: T.fontSans,
    borderBottom: `1px solid ${T.border}`,
  },
  headerTime: { color: T.info },
  headerLocation: { color: T.gold },
  headerChar: { color: T.accent },
  sceneArea: {
    flex: 1,
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  history: {
    flex: 1,
    overflowY: 'auto',
    padding: '16px 24px',
    maskImage: 'linear-gradient(transparent 0%, black 15%)',
    WebkitMaskImage: 'linear-gradient(transparent 0%, black 15%)',
  },
  historyEntry: {
    marginBottom: '12px',
    opacity: 0.55,
    fontSize: '14px',
    lineHeight: '1.8',
  },
  historyNarration: {
    fontStyle: 'italic',
    color: T.narration,
    margin: '4px 0',
  },
  historyDialogue: {
    margin: '4px 0',
    color: T.textSecondary,
  },
  dialogueBox: {
    background: T.bgSurface,
    borderTop: `1px solid ${T.border}`,
    padding: '16px 24px',
    minHeight: '140px',
    flexShrink: 0,
  },
  narration: {
    fontStyle: 'italic',
    color: T.narration,
    fontSize: '13px',
    margin: '0 0 8px 0',
    lineHeight: '1.6',
  },
  dialogueContent: {},
  speakerTag: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginBottom: '6px',
  },
  speakerName: {
    color: T.speaker,
    fontWeight: 'bold',
    fontSize: '15px',
  },
  emotionBadge: {
    fontSize: '12px',
    background: T.accentMuted,
    padding: '2px 8px',
    borderRadius: T.radiusPill,
    color: T.textSecondary,
    fontFamily: T.fontSans,
  },
  dialogueText: {
    fontSize: '16px',
    lineHeight: '1.8',
    margin: 0,
    color: T.textPrimary,
    minHeight: '50px',
  },
  cursor: {
    animation: 'blink 1s infinite',
    color: T.accent,
  },
  queueHint: {
    textAlign: 'right',
    color: T.textMuted,
    fontSize: '11px',
    marginTop: '8px',
    fontFamily: T.fontSans,
  },
  emptyHint: {
    color: T.textMuted,
    fontStyle: 'italic',
    fontSize: '14px',
    margin: 0,
  },
};
