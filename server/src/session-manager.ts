/**
 * SessionManager — 管理后端游玩会话
 *
 * 简化后：用 playthroughId 作为 wrapper 的唯一 key。
 * 不再对外暴露独立的 "gameSessionId"——客户端只需要知道 playthroughId。
 *
 * 断线后 wrapper 保留在内存中 TTL 10 分钟，期间同 playthroughId 重连零成本恢复。
 * TTL 过期后 wrapper 销毁，下次重连需从 DB 恢复。
 */

import { GameSession } from '../../src/core/game-session';
import type { GameSessionConfig, RestoreConfig } from '../../src/core/game-session';
import type { ScriptManifest, PromptSegment } from '../../src/core/types';
import type { LLMConfig } from '../../src/core/llm-client';
import { createWebSocketEmitter } from './ws-session-emitter';
import { getLLMConfig } from './storage/llm-config-store';
import { createPlaythroughPersistence } from './services/playthrough-persistence';
import { createBoundTracing } from './tracing';

// ============================================================================
// Config
// ============================================================================

/** 断线后 wrapper 在内存中保留的时间 */
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
  private playthroughId: string;
  private userId: string;
  /** 'production' | 'playtest'，用于 Langfuse trace environment 区分 */
  private kind: string;
  private ws: WS | null = null;
  /** 断线后的 TTL 定时器 */
  private ttlTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    manifest: ScriptManifest,
    playthroughId: string,
    userId: string,
    kind: string = 'production',
  ) {
    this.manifest = manifest;
    this.playthroughId = playthroughId;
    this.userId = userId;
    this.kind = kind;
  }

  attachWebSocket(ws: WS): void {
    this.clearTTL();
    this.ws = ws;
    const emitter = createWebSocketEmitter(ws);
    this.gameSession = new GameSession(emitter);
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
      tracing: base.tracing,
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

  getPlaythroughId(): string {
    return this.playthroughId;
  }

  getUserId(): string {
    return this.userId;
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
      persistence: createPlaythroughPersistence(this.playthroughId),
      tracing: createBoundTracing({
        playthroughId: this.playthroughId,
        userId: this.userId,
        // TODO(6.3): 改用真实的 script_version_id；现在临时用 manifest.id
        // 作为 trace label，语义上就是"这个 playthrough 基于哪份 manifest"
        scriptVersionId: manifest.id,
        kind: this.kind,
      }),
    };
  }
}

// ============================================================================
// SessionManager
// ============================================================================

export class SessionManager {
  /** playthroughId → wrapper */
  private sessions = new Map<string, GameSessionWrapper>();

  /**
   * 获取已有 wrapper，或创建一个新的（懒加载）
   * 调用方负责在之后调 attachWebSocket + start/restore
   */
  getOrCreate(
    playthroughId: string,
    manifest: ScriptManifest,
    userId: string,
    kind: string = 'production',
  ): GameSessionWrapper {
    let wrapper = this.sessions.get(playthroughId);
    if (!wrapper) {
      wrapper = new GameSessionWrapper(manifest, playthroughId, userId, kind);
      this.sessions.set(playthroughId, wrapper);
    }
    return wrapper;
  }

  get(playthroughId: string): GameSessionWrapper | undefined {
    return this.sessions.get(playthroughId);
  }

  /** 断线时调用——启动 TTL，到期销毁 */
  detach(playthroughId: string): void {
    const wrapper = this.sessions.get(playthroughId);
    if (!wrapper) return;

    wrapper.startTTL(() => {
      this.sessions.delete(playthroughId);
      console.log(`[SessionManager] Wrapper ${playthroughId} expired after TTL`);
    });
  }

  /** 立即销毁 */
  destroy(playthroughId: string): void {
    const wrapper = this.sessions.get(playthroughId);
    if (wrapper) wrapper.stop();
    this.sessions.delete(playthroughId);
  }
}
