/**
 * Game Renderer - React-based visual novel UI.
 * MVP: Pure React rendering instead of full Pixi'VN canvas.
 * Implements typewriter text effect, character display, and dialogue box.
 */

import { useState, useEffect, useRef } from 'react';
import type { SceneOutput } from '../memory/schemas';

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
  const historyRef = useRef<HTMLDivElement>(null);
  const prevScenesRef = useRef<SceneOutput[]>([]);

  // The latest scene is always the last one in the current batch
  const currentScene = scenes.length > 0 ? scenes[scenes.length - 1] : null;
  // Fallback: if dialogue is empty, use narration as display text
  const displayText = currentScene
    ? (currentScene.dialogue || currentScene.narration || '')
    : '';
  const { displayed, isComplete } = useTypewriter(displayText, 40);

  // When new scenes arrive, flush previous batch + all-but-last of new batch into history
  useEffect(() => {
    if (scenes.length === 0) return;

    setHistory((h) => {
      const additions: SceneOutput[] = [];
      // Flush all previous scenes into history
      if (prevScenesRef.current.length > 0) {
        additions.push(...prevScenesRef.current);
      }
      // Add all but the last scene of the new batch (last one gets typewriter)
      if (scenes.length > 1) {
        additions.push(...scenes.slice(0, -1));
      }
      return additions.length > 0 ? [...h, ...additions] : h;
    });

    prevScenesRef.current = scenes.length > 0 ? [scenes[scenes.length - 1]] : [];
  }, [scenes]);

  // Auto-scroll history when it changes or typewriter progresses
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
    background: 'linear-gradient(180deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)',
    color: '#e0e0e0',
    fontFamily: '"Noto Serif SC", "Source Han Serif CN", serif',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '8px 16px',
    background: 'rgba(0,0,0,0.4)',
    fontSize: '13px',
    color: '#aaa',
    flexShrink: 0,
  },
  headerTime: { color: '#7ec8e3' },
  headerLocation: { color: '#c3a76e' },
  headerChar: { color: '#e6c3a1' },
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
    opacity: 0.6,
    fontSize: '14px',
    lineHeight: '1.8',
  },
  historyNarration: {
    fontStyle: 'italic',
    color: '#8899aa',
    margin: '4px 0',
  },
  historyDialogue: {
    margin: '4px 0',
    color: '#c0c0c0',
  },
  dialogueBox: {
    background: 'rgba(0, 0, 0, 0.75)',
    backdropFilter: 'blur(10px)',
    borderTop: '1px solid rgba(255,255,255,0.1)',
    padding: '16px 24px',
    minHeight: '140px',
    flexShrink: 0,
  },
  narration: {
    fontStyle: 'italic',
    color: '#8899aa',
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
    color: '#c3a76e',
    fontWeight: 'bold',
    fontSize: '15px',
  },
  emotionBadge: {
    fontSize: '12px',
    background: 'rgba(255,255,255,0.1)',
    padding: '2px 8px',
    borderRadius: '10px',
    color: '#aaa',
  },
  dialogueText: {
    fontSize: '16px',
    lineHeight: '1.8',
    margin: 0,
    color: '#f0f0f0',
    minHeight: '50px',
  },
  cursor: {
    animation: 'blink 1s infinite',
    color: '#7ec8e3',
  },
};
