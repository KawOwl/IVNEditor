/**
 * SessionManager — 管理后端游玩会话
 *
 * 每个玩家连接创建一个 GameSession 实例。
 * playthroughId → GameSessionWrapper 映射。
 */

import { GameSession } from '../../src/core/game-session';
import type { GameSessionConfig, RestoreConfig } from '../../src/core/game-session';
import type { ScriptManifest, PromptSegment } from '../../src/core/types';
import type { LLMConfig } from '../../src/core/llm-client';
import { createWebSocketEmitter } from './ws-session-emitter';
import { getLLMConfig } from './storage/llm-config-store';
import { createPlaythroughPersistence } from './services/playthrough-persistence';

// ============================================================================
// LLM Config — 从可变 config store 读取（编剧可通过 API 动态更新）
// ============================================================================

function getServerLLMConfig(): LLMConfig {
  const cfg = getLLMConfig();
  return {
    provider: cfg.provider,
    baseURL: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
    name: cfg.name,
  };
}

// ============================================================================
// GameSessionWrapper — 单个会话
// ============================================================================

type WS = { send(data: string): void };

export class GameSessionWrapper {
  private gameSession: GameSession | null = null;
  private manifest: ScriptManifest;
  private playthroughId: string | null;
  private ws: WS | null = null;

  constructor(manifest: ScriptManifest, playthroughId?: string | null) {
    this.manifest = manifest;
    this.playthroughId = playthroughId ?? null;
  }

  attachWebSocket(ws: WS): void {
    this.ws = ws;
    const emitter = createWebSocketEmitter(ws);
    this.gameSession = new GameSession(emitter);
  }

  start(): void {
    if (!this.gameSession) return;

    const config = this.buildConfig();
    this.gameSession.start(config);
  }

  /**
   * 从 DB 快照恢复会话（跳过初始化，直接进入对应阶段）
   */
  restore(snapshot: {
    stateVars: Record<string, unknown>;
    turn: number;
    memoryEntries: unknown[];
    memorySummaries: string[];
    status: string;
    inputHint?: string | null;
    inputType?: string;
    choices?: string[] | null;
  }): void {
    if (!this.gameSession) return;

    const base = this.buildConfig();
    const restoreConfig: RestoreConfig = {
      segments: base.segments,
      stateSchema: base.stateSchema,
      memoryConfig: base.memoryConfig,
      llmConfig: base.llmConfig,
      enabledTools: base.enabledTools,
      tokenBudget: base.tokenBudget,
      initialPrompt: base.initialPrompt,
      assemblyOrder: base.assemblyOrder,
      disabledSections: base.disabledSections,
      persistence: base.persistence,
      ...snapshot,
    };

    this.gameSession.restore(restoreConfig);
  }

  private buildConfig(): GameSessionConfig {
    const manifest = this.manifest;
    const allSegments: PromptSegment[] = manifest.chapters.flatMap((ch) => ch.segments);

    return {
      chapterId: manifest.chapters[0]?.id ?? 'ch1',
      segments: allSegments,
      stateSchema: manifest.stateSchema,
      memoryConfig: manifest.memoryConfig,
      llmConfig: getServerLLMConfig(),
      enabledTools: manifest.enabledTools,
      tokenBudget: manifest.memoryConfig.contextBudget,
      initialPrompt: manifest.initialPrompt,
      assemblyOrder: manifest.promptAssemblyOrder,
      persistence: this.playthroughId
        ? createPlaythroughPersistence(this.playthroughId)
        : undefined,
    };
  }

  submitInput(text: string): void {
    this.gameSession?.submitInput(text);
  }

  stop(): void {
    this.gameSession?.stop();
  }

  getPlaythroughId(): string | null {
    return this.playthroughId;
  }
}

// ============================================================================
// SessionManager
// ============================================================================

export class SessionManager {
  private sessions = new Map<string, GameSessionWrapper>();

  create(sessionId: string, manifest: ScriptManifest, playthroughId?: string): void {
    this.sessions.set(sessionId, new GameSessionWrapper(manifest, playthroughId));
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
