/**
 * App - Main application component.
 * Three views: start → settings → game.
 * Loads game data dynamically from the selected script bundle.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { GameRenderer } from './engine/game-renderer';
import { DebugDrawer } from './debug/DebugDrawer';
import { ChatInput } from './player/ChatInput';
import { SettingsScreen } from './settings/SettingsScreen';
import { CoreLoop } from './engine/core-loop';
import { NovelContextEngine } from './memory/context-engine';
import { useCharacterStore } from './memory/character-store';
import { useDebugStore } from './debug/debug-store';
import { usePlayerStore } from './player/player-store';
import { useSettingsStore } from './settings/settings-store';
import { Timeline } from './timeline/timeline';
import type { SceneOutput, WorldEvent, GOAPAction } from './memory/schemas';

type AppView = 'start' | 'settings' | 'game';

export function App() {
  const [view, setView] = useState<AppView>('start');
  const [scenes, setScenes] = useState<SceneOutput[]>([]);
  const [gameLog, setGameLog] = useState<string[]>([]);
  const coreLoopRef = useRef<CoreLoop | null>(null);
  const timelineRef = useRef<Timeline | null>(null);
  const contextEngineRef = useRef<NovelContextEngine | null>(null);

  const initCharacter = useCharacterStore((s) => s.initCharacter);
  const debug = useDebugStore();
  const playerMode = usePlayerStore((s) => s.mode);

  // Settings store
  const settingsInitialized = useSettingsStore((s) => s.initialized);
  const activeScript = useSettingsStore((s) => s.activeScript);

  // Initialize storage on mount
  useEffect(() => {
    useSettingsStore.getState().initStorage();
  }, []);

  const handleStart = useCallback(() => {
    const script = useSettingsStore.getState().activeScript;
    if (!script) return;

    // Initialize all characters from the script
    for (const character of script.characters) {
      initCharacter(character.core.id, character);
    }

    // Use first chapter for timeline
    const chapter = script.chapters[0];
    const timeline = new Timeline(
      480, // 08:00
      chapter.events as WorldEvent[],
      chapter.locations,
    );
    timelineRef.current = timeline;

    const contextEngine = new NovelContextEngine(() =>
      timeline.buildWorldState(
        'home',
        script.characters.slice(1).map((c) => c.core.id), // NPCs = all characters except first
        timeline.getActiveEvents().length > 0
          ? timeline.getActiveEvents().map((e) => e.description).join('；')
          : `${timeline.formatTime()}，一切平静。`,
      ),
    );
    contextEngineRef.current = contextEngine;

    const primaryCharId = script.characters[0].core.id;

    const loop = new CoreLoop({
      characterId: primaryCharId,
      contextEngine,
      timeline,
      goapActions: [...script.goapActions] as GOAPAction[],
      onScenesReady: (newScenes) => {
        setScenes(newScenes);
        setGameLog((log) => [
          ...log,
          ...newScenes.map((s) =>
            s.speaker
              ? `${s.speaker}：${s.dialogue}`
              : s.dialogue,
          ),
        ]);
      },
      onLoopComplete: () => {
        // Loop completed one cycle
      },
      onError: (error) => {
        setGameLog((log) => [...log, `[错误] ${error.message}`]);
      },
    });

    coreLoopRef.current = loop;
    setView('game');
    setScenes([]);
    setGameLog([]);
    debug.reset();

    // Start in background
    loop.start().catch((err) => {
      console.error('Core loop crashed:', err);
      setView('start');
    });
  }, [initCharacter, debug]);

  const handleStop = useCallback(() => {
    coreLoopRef.current?.stop();
    setView('start');
  }, []);

  const handlePauseResume = useCallback(() => {
    const loop = coreLoopRef.current;
    if (!loop) return;
    if (loop.isPaused()) {
      loop.resume();
    } else {
      loop.pause();
    }
  }, []);

  const handlePlayerMessage = useCallback((message: string) => {
    const loop = coreLoopRef.current;
    if (!loop) return;
    if (loop.isPaused()) {
      loop.resume();
    }
  }, []);

  // Derive display info from active script
  const primaryChar = activeScript?.characters[0];
  const charName = primaryChar?.core.name ?? '';
  const charDesc = activeScript?.metadata.description ?? '';

  return (
    <div style={styles.layout}>
      {/* Game area */}
      <div style={styles.gameArea}>
        {view === 'start' && (
          <div style={styles.startScreen}>
            <h1 style={styles.title}>AI互动视觉小说引擎</h1>
            <p style={styles.subtitle}>Agent记忆系统验证 MVP</p>

            {settingsInitialized && activeScript ? (
              <div style={styles.charInfo}>
                <p style={styles.scriptLabel}>{activeScript.metadata.name}</p>
                <p style={styles.charName}>{charName}</p>
                <p style={styles.charDesc}>{charDesc}</p>
                <p style={styles.charMeta}>
                  {activeScript.characters.length} 角色 · {activeScript.chapters[0]?.events.length ?? 0} 事件 · {activeScript.goapActions.length} 动作
                </p>
              </div>
            ) : (
              <div style={styles.charInfo}>
                <p style={styles.charDesc}>正在加载...</p>
              </div>
            )}

            <div style={styles.btnGroup}>
              <button
                style={{
                  ...styles.startBtn,
                  opacity: activeScript ? 1 : 0.4,
                }}
                onClick={handleStart}
                disabled={!activeScript}
              >
                开始游戏
              </button>
              <button
                style={styles.settingsBtn}
                onClick={() => setView('settings')}
              >
                ⚙ 设置
              </button>
            </div>

            <p style={styles.hint}>
              底部输入框可切换"自主运行"和"介入模式"
            </p>
          </div>
        )}

        {view === 'settings' && (
          <SettingsScreen
            onBack={() => setView('start')}
            onStartGame={handleStart}
          />
        )}

        {view === 'game' && (
          <div style={styles.gameContent}>
            {/* Control bar */}
            <div style={styles.controlBar}>
              <button style={styles.controlBtn} onClick={handlePauseResume}>
                {coreLoopRef.current?.isPaused() ? '▶ 继续' : '⏸ 暂停'}
              </button>
              <button style={styles.controlBtn} onClick={handleStop}>
                ⏹ 停止
              </button>
              <span style={styles.modeIndicator}>
                {playerMode === 'autonomous' ? '🔄 自主' : '✋ 介入'}
              </span>
            </div>

            {/* Game renderer */}
            <div style={styles.rendererWrap}>
              <GameRenderer
                scenes={scenes}
                characterName={charName}
                currentTime={debug.timeline.currentTime || '08:00'}
                currentLocation={
                  timelineRef.current?.getLocationName(
                    debug.currentGoal?.where ?? 'home',
                  ) ?? activeScript?.chapters[0]?.locations[0]?.name ?? ''
                }
              />
            </div>

            {/* Player chat input */}
            <ChatInput
              onSendMessage={(msg) => {
                usePlayerStore.getState().sendMessage(msg);
                handlePlayerMessage(msg);
              }}
              isRunning={view === 'game'}
            />
          </div>
        )}
      </div>

      {/* Debug drawer */}
      <DebugDrawer />
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  layout: {
    display: 'flex',
    width: '100vw',
    height: '100vh',
    overflow: 'hidden',
    background: '#0f0f1a',
  },
  gameArea: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  startScreen: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'linear-gradient(180deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)',
    gap: '16px',
  },
  title: {
    color: '#e6c3a1',
    fontSize: '28px',
    fontFamily: '"Noto Serif SC", serif',
    margin: 0,
  },
  subtitle: {
    color: '#7ec8e3',
    fontSize: '14px',
    margin: 0,
  },
  charInfo: {
    background: 'rgba(255,255,255,0.05)',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: '8px',
    padding: '16px 24px',
    textAlign: 'center',
    marginTop: '16px',
    minWidth: '280px',
  },
  scriptLabel: {
    color: '#7ec8e3',
    fontSize: '11px',
    margin: '0 0 6px',
    textTransform: 'uppercase' as const,
    letterSpacing: '1px',
  },
  charName: {
    color: '#e6c3a1',
    fontSize: '18px',
    fontWeight: 'bold',
    margin: '0 0 8px 0',
  },
  charDesc: {
    color: '#aaa',
    fontSize: '13px',
    margin: 0,
  },
  charMeta: {
    color: '#666',
    fontSize: '11px',
    marginTop: '8px',
  },
  btnGroup: {
    display: 'flex',
    gap: '12px',
    marginTop: '24px',
  },
  startBtn: {
    padding: '12px 48px',
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    color: 'white',
    borderWidth: '0',
    borderStyle: 'none',
    borderRadius: '24px',
    fontSize: '16px',
    cursor: 'pointer',
    fontFamily: '"Noto Serif SC", serif',
  },
  settingsBtn: {
    padding: '12px 24px',
    background: 'rgba(255,255,255,0.06)',
    color: '#aaa',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'rgba(255,255,255,0.15)',
    borderRadius: '24px',
    fontSize: '14px',
    cursor: 'pointer',
  },
  hint: {
    color: '#555',
    fontSize: '12px',
    marginTop: '16px',
  },
  gameContent: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  controlBar: {
    display: 'flex',
    gap: '8px',
    padding: '6px 12px',
    background: '#181825',
    borderBottom: '1px solid #333',
    alignItems: 'center',
  },
  controlBtn: {
    padding: '4px 12px',
    background: '#2a2a3a',
    color: '#ccc',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: '#444',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '12px',
  },
  modeIndicator: {
    marginLeft: 'auto',
    color: '#888',
    fontSize: '12px',
  },
  rendererWrap: {
    flex: 1,
    overflow: 'hidden',
  },
};
