/**
 * SessionManager — 管理后端游玩会话
 *
 * 每个玩家连接创建一个 GameSession 实例。
 * sessionId → GameSessionWrapper 映射。
 */

import { GameSession } from '../../src/core/game-session';
import type { GameSessionConfig } from '../../src/core/game-session';
import type { ScriptManifest, PromptSegment } from '../../src/core/types';
import type { LLMConfig } from '../../src/core/llm-client';
import { createWebSocketEmitter } from './ws-session-emitter';

// ============================================================================
// LLM Config — 后端从环境变量读取（API Key 保密）
// ============================================================================

function getServerLLMConfig(): LLMConfig {
  return {
    provider: process.env.LLM_PROVIDER ?? 'openai-compatible',
    baseURL: process.env.LLM_BASE_URL ?? 'https://api.deepseek.com/v1',
    apiKey: process.env.LLM_API_KEY ?? '',
    model: process.env.LLM_MODEL ?? 'deepseek-chat',
    name: process.env.LLM_NAME ?? 'server-llm',
  };
}

// ============================================================================
// GameSessionWrapper — 单个会话
// ============================================================================

type WS = { send(data: string): void };

export class GameSessionWrapper {
  private gameSession: GameSession | null = null;
  private manifest: ScriptManifest;
  private ws: WS | null = null;

  constructor(manifest: ScriptManifest) {
    this.manifest = manifest;
  }

  attachWebSocket(ws: WS): void {
    this.ws = ws;
    const emitter = createWebSocketEmitter(ws);
    this.gameSession = new GameSession(emitter);
  }

  start(): void {
    if (!this.gameSession) return;

    const manifest = this.manifest;
    const allSegments: PromptSegment[] = manifest.chapters.flatMap((ch) => ch.segments);

    const config: GameSessionConfig = {
      chapterId: manifest.chapters[0]?.id ?? 'ch1',
      segments: allSegments,
      stateSchema: manifest.stateSchema,
      memoryConfig: manifest.memoryConfig,
      llmConfig: getServerLLMConfig(),
      enabledTools: manifest.enabledTools,
      tokenBudget: manifest.memoryConfig.contextBudget,
      initialPrompt: manifest.initialPrompt,
    };

    this.gameSession.start(config);
  }

  submitInput(text: string): void {
    this.gameSession?.submitInput(text);
  }

  stop(): void {
    this.gameSession?.stop();
  }
}

// ============================================================================
// SessionManager
// ============================================================================

export class SessionManager {
  private sessions = new Map<string, GameSessionWrapper>();

  create(sessionId: string, manifest: ScriptManifest): void {
    this.sessions.set(sessionId, new GameSessionWrapper(manifest));
  }

  get(sessionId: string): GameSessionWrapper | undefined {
    return this.sessions.get(sessionId);
  }

  destroy(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    session?.stop();
    this.sessions.delete(sessionId);
  }
}
