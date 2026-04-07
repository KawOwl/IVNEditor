/**
 * SessionManager — 管理后端游玩会话
 *
 * 两层索引：
 *   sessionId → GameSessionWrapper（WS 连接用）
 *   playthroughId → sessionId（重连查找用）
 *
 * 断线后 session 保留在内存中（TTL），超时后销毁。
 * 重连时优先从内存恢复（零成本），内存无则从 DB 恢复。
 */

import { GameSession } from '../../src/core/game-session';
import type { GameSessionConfig, RestoreConfig } from '../../src/core/game-session';
import type { ScriptManifest, PromptSegment } from '../../src/core/types';
import type { LLMConfig } from '../../src/core/llm-client';
import { createWebSocketEmitter } from './ws-session-emitter';
import { getLLMConfig } from './storage/llm-config-store';
import { createPlaythroughPersistence } from './services/playthrough-persistence';

// ============================================================================
// Config
// ============================================================================

/** 断线后 session 在内存中保留的时间（毫秒） */
const SESSION_TTL_MS = 10 * 60 * 1000; // 10 分钟

// ============================================================================
// LLM Config
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
// GameSessionWrapper
// ============================================================================

type WS = { send(data: string): void };

export class GameSessionWrapper {
  private gameSession: GameSession | null = null;
  private manifest: ScriptManifest;
  private playthroughId: string | null;
  private ws: WS | null = null;
  /** 断线后的 TTL 定时器 */
  private ttlTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(manifest: ScriptManifest, playthroughId?: string | null) {
    this.manifest = manifest;
    this.playthroughId = playthroughId ?? null;
  }

  attachWebSocket(ws: WS): void {
    // 清除 TTL 定时器（重连成功）
    this.clearTTL();
    this.ws = ws;
    const emitter = createWebSocketEmitter(ws);
    this.gameSession = new GameSession(emitter);
  }

  /**
   * 重连时重新附加 WS（不创建新 GameSession）
   * 返回 false 如果 session 不可重连（已被停止等）
   */
  reattachWebSocket(ws: WS): boolean {
    this.clearTTL();
    this.ws = ws;
    // GameSession 仍在内存中运行，但 emitter 指向旧 WS
    // 需要更新 emitter — 但当前 GameSession 不支持热替换 emitter
    // 所以内存重连场景下，我们返回 true 表示 session 存在，
    // 但客户端需要从 DB 恢复状态（因为 WS 流已断）
    return this.gameSession !== null;
  }

  start(): void {
    if (!this.gameSession) return;
    const config = this.buildConfig();
    this.gameSession.start(config);
  }

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

  submitInput(text: string): void {
    this.gameSession?.submitInput(text);
  }

  stop(): void {
    this.clearTTL();
    this.gameSession?.stop();
  }

  getPlaythroughId(): string | null {
    return this.playthroughId;
  }

  /** 启动 TTL 定时器，到期后调用 onExpire */
  startTTL(onExpire: () => void): void {
    this.clearTTL();
    this.ttlTimer = setTimeout(() => {
      this.ttlTimer = null;
      this.stop();
      onExpire();
    }, SESSION_TTL_MS);
  }

  private clearTTL(): void {
    if (this.ttlTimer) {
      clearTimeout(this.ttlTimer);
      this.ttlTimer = null;
    }
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
}

// ============================================================================
// SessionManager
// ============================================================================

export class SessionManager {
  private sessions = new Map<string, GameSessionWrapper>();
  /** playthroughId → sessionId 反向索引（用于重连查找） */
  private playthroughIndex = new Map<string, string>();

  create(sessionId: string, manifest: ScriptManifest, playthroughId?: string): void {
    const wrapper = new GameSessionWrapper(manifest, playthroughId);
    this.sessions.set(sessionId, wrapper);
    if (playthroughId) {
      this.playthroughIndex.set(playthroughId, sessionId);
    }
  }

  get(sessionId: string): GameSessionWrapper | undefined {
    return this.sessions.get(sessionId);
  }

  /** 通过 playthroughId 查找活跃 session */
  getByPlaythroughId(playthroughId: string): { sessionId: string; wrapper: GameSessionWrapper } | undefined {
    const sessionId = this.playthroughIndex.get(playthroughId);
    if (!sessionId) return undefined;
    const wrapper = this.sessions.get(sessionId);
    if (!wrapper) return undefined;
    return { sessionId, wrapper };
  }

  /**
   * 断线时调用——不立即销毁，启动 TTL
   */
  detach(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.startTTL(() => {
      // TTL 到期，真正销毁
      this.sessions.delete(sessionId);
      const ptId = session.getPlaythroughId();
      if (ptId) this.playthroughIndex.delete(ptId);
      console.log(`[SessionManager] Session ${sessionId} expired after TTL`);
    });
  }

  /** 立即销毁 */
  destroy(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.stop();
      const ptId = session.getPlaythroughId();
      if (ptId) this.playthroughIndex.delete(ptId);
    }
    this.sessions.delete(sessionId);
  }
}
