/**
 * Game Renderer - React-based visual novel UI.
 * MVP: Pure React rendering instead of full Pixi'VN canvas.
 * Implements typewriter text effect, character display, and dialogue box.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import type { SceneOutput } from '../memory/schemas';

interface GameRendererProps {
  scenes: SceneOutput[];
  characterName: string;
  currentTime: string;
  currentLocation: string;
  onSceneComplete?: () => void;
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

  const complete = useCallback(() => {
    setDisplayed(text);
    setIsComplete(true);
  }, [text]);

  return { displayed, isComplete, complete };
}

export function GameRenderer({
  scenes,
  characterName,
  currentTime,
  currentLocation,
  onSceneComplete,
}: GameRendererProps) {
  const [currentSceneIndex, setCurrentSceneIndex] = useState(0);
  const [history, setHistory] = useState<SceneOutput[]>([]);
  const historyRef = useRef<HTMLDivElement>(null);

  const scene = scenes[currentSceneIndex];
  const { displayed, isComplete, complete } = useTypewriter(
    scene?.dialogue ?? '',
    40,
  );

  // Auto-scroll history
  useEffect(() => {
    if (historyRef.current) {
      historyRef.current.scrollTop = historyRef.current.scrollHeight;
    }
  }, [history]);

  // Reset scene index when new scenes arrive
  useEffect(() => {
    if (scenes.length > 0) {
      setCurrentSceneIndex(0);
    }
  }, [scenes]);

  const handleClick = () => {
    if (!isComplete) {
      complete();
      return;
    }

    // Add to history
    if (scene) {
      setHistory((h) => [...h, scene]);
    }

    if (currentSceneIndex < scenes.length - 1) {
      setCurrentSceneIndex((i) => i + 1);
    } else {
      onSceneComplete?.();
    }
  };

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
    <div style={styles.container} onClick={handleClick}>
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
          {history.map((h, i) => (
            <div key={i} style={styles.historyEntry}>
              {h.narration && (
                <p style={styles.historyNarration}>{h.narration}</p>
              )}
              {h.speaker ? (
                <p style={styles.historyDialogue}>
                  <span style={styles.speakerName}>{h.speaker}</span>
                  ：{h.dialogue}
                </p>
              ) : (
                <p style={styles.historyNarration}>{h.dialogue}</p>
              )}
            </div>
          ))}
        </div>

        {/* Character portrait placeholder */}
        {scene?.speaker && (
          <div style={styles.portrait}>
            <div style={styles.portraitCircle}>
              {scene.speaker.charAt(0)}
            </div>
            <span style={styles.portraitEmotion}>
              {emotionToEmoji[scene.emotion ?? 'neutral']}
            </span>
          </div>
        )}
      </div>

      {/* Dialogue box */}
      <div style={styles.dialogueBox}>
        {scene?.narration && (
          <p style={styles.narration}>{scene.narration}</p>
        )}
        <div style={styles.dialogueContent}>
          {scene?.speaker && (
            <div style={styles.speakerTag}>
              {scene.speaker}
              {scene.emotion && (
                <span style={styles.emotionBadge}>
                  {emotionToEmoji[scene.emotion] ?? ''} {scene.emotion}
                </span>
              )}
            </div>
          )}
          <p style={styles.dialogueText}>
            {displayed}
            {!isComplete && <span style={styles.cursor}>▊</span>}
          </p>
        </div>
        {isComplete && (
          <div style={styles.continueHint}>
            ▼ 点击继续
          </div>
        )}
      </div>
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
    cursor: 'pointer',
    userSelect: 'none',
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
  portrait: {
    position: 'absolute',
    right: '40px',
    bottom: '20px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
  },
  portraitCircle: {
    width: '80px',
    height: '80px',
    borderRadius: '50%',
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '32px',
    fontWeight: 'bold',
    color: 'white',
    borderWidth: '2px',
    borderStyle: 'solid',
    borderColor: 'rgba(255,255,255,0.3)',
  },
  portraitEmotion: {
    fontSize: '24px',
    marginTop: '4px',
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
  continueHint: {
    textAlign: 'center',
    color: '#666',
    fontSize: '12px',
    marginTop: '8px',
    animation: 'pulse 2s infinite',
  },
};
