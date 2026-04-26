/**
 * SessionManager — 管理后端游玩会话
 *
 * 简化后：用 playthroughId 作为 wrapper 的唯一 key。
 * 不再对外暴露独立的 "gameSessionId"——客户端只需要知道 playthroughId。
 *
 * 断线后 wrapper 保留在内存中 TTL 10 分钟，期间同 playthroughId 重连零成本恢复。
 * TTL 过期后 wrapper 销毁，下次重连需从 DB 恢复。
 */

import { GameSession } from '@ivn/core/game-session';
import {
  createCoreEventBus,
  createCoreEventLogSink,
} from '@ivn/core/game-session';
import type {
  CoreEventSink,
  GameSessionConfig,
  RestoreConfig,
  ProtocolVersion,
} from '@ivn/core/game-session';
import type { ScriptManifest, PromptSegment, SceneState } from '@ivn/core/types';
import type { LLMConfig } from '@ivn/core/llm-client';
import { buildParserManifest, type ParserManifest } from '@ivn/core/narrative-parser-v2';
import { CURRENT_PROTOCOL_VERSION } from '@ivn/core/protocol-version';
import { createWebSocketCoreEventSink } from '#internal/ws-core-event-sink';
import { createPlaythroughPersistence } from '#internal/services/playthrough-persistence';
import { createCoreEventHistoryReader } from '#internal/services/core-event-history-reader';
import { coreEventLogService } from '#internal/services/core-event-log';
import { createBoundTracing } from '#internal/tracing';
import { getServerEnv } from '#internal/env';

// ============================================================================
// Config
// ============================================================================

/** 断线后 wrapper 在内存中保留的时间 */
const SESSION_TTL_MS = 10 * 60 * 1000; // 10 分钟

// ============================================================================
// GameSessionWrapper
// ============================================================================

type WS = { send(data: string): void };

export class GameSessionWrapper {
  private gameSession: GameSession | null = null;
  private manifest: ScriptManifest;
  private playthroughId: string;
  /** 真实的 script_versions.id（从 playthrough.scriptVersionId 传进来），供 trace label 用 */
  private scriptVersionId: string;
  private userId: string;
  /** 'production' | 'playtest'，用于 Langfuse trace environment 区分 */
  private kind: string;
  /** v2.7：从 playthrough.llm_config_id 查出来的完整配置，每个 wrapper 固定一份 */
  private llmConfig: LLMConfig;
  private ws: WS | null = null;
  private coreEventSink: CoreEventSink | null = null;
  /** 断线后的 TTL 定时器 */
  private ttlTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    manifest: ScriptManifest,
    scriptVersionId: string,
    playthroughId: string,
    userId: string,
    kind: string,
    llmConfig: LLMConfig,
  ) {
    this.manifest = manifest;
    this.scriptVersionId = scriptVersionId;
    this.playthroughId = playthroughId;
    this.userId = userId;
    this.kind = kind;
    this.llmConfig = llmConfig;
  }

  async attachWebSocket(ws: WS): Promise<void> {
    this.clearTTL();

    // 停掉旧 GameSession，防止同一 playthrough 在两个 wrapper 中并发推进。
    if (this.gameSession) {
      this.gameSession.stop();
      this.gameSession = null;
    }

    this.ws = ws;
    const lastSequence = await coreEventLogService.getLastSequence(this.playthroughId);
    this.coreEventSink = createCoreEventBus([
      createCoreEventLogSink({
        playthroughId: this.playthroughId,
        writer: coreEventLogService.createWriter(),
        initialSequence: lastSequence,
      }),
      createWebSocketCoreEventSink(ws, {
        enableDebug: this.kind === 'playtest',
      }),
    ]);
    this.gameSession = new GameSession();
  }

  start(): void {
    if (!this.gameSession) return;
    const config = this.buildConfig();
    this.gameSession.start(config);
  }

  restore(snapshot: {
    stateVars: Record<string, unknown>;
    turn: number;
    /** opaque Memory snapshot，null 表示新 playthrough 还无历史 */
    memorySnapshot: Record<string, unknown> | null;
    status: string;
    inputHint?: string | null;
    inputType?: string;
    choices?: string[] | null;
    /** M3: VN 场景快照（可选，老 playthrough 为 null） */
    currentScene?: {
      background: string | null;
      sprites: Array<{ id: string; emotion: string; position?: string }>;
    } | null;
  }): void {
    if (!this.gameSession) return;

    const base = this.buildConfig();
    const restoreConfig: RestoreConfig = {
      // Memory scope —— 让 restore 路径也能构造 Memory adapter
      playthroughId: base.playthroughId,
      userId: base.userId,
      chapterId: base.chapterId,

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
      coreEventSink: base.coreEventSink,
      // mem0 key 从 base 带过来（base 已经从 env 读好了）
      mem0ApiKey: base.mem0ApiKey,
      coreEventReader: base.coreEventReader,
      // V.2：parser 分叉键 + 白名单；restore 路径和 start 走同一份，保证重连后
      // parser 选型不跳变
      protocolVersion: base.protocolVersion,
      parserManifest: base.parserManifest,
      // V.3：prompt 白名单。restore 路径同样透传。
      characters: base.characters,
      backgrounds: base.backgrounds,
      ...snapshot,
      // M3: currentScene 从 snapshot 取，defaultScene 从 manifest 取（restore 时用作 fallback）
      defaultScene: base.defaultScene,
      currentScene: snapshot.currentScene as SceneState | null | undefined,
    };

    this.gameSession.restore(restoreConfig);
  }

  async submitInput(text: string): Promise<void> {
    await this.gameSession?.submitInput(text);
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

    // 当前运行协议缺省为声明式视觉 IR。manifest 显式标成 v1-tool-call 时，
    // core runtime 会拒绝执行；server 仍可保留 manifest 供历史读取/迁移工具解析。
    const protocolVersion: ProtocolVersion = manifest.protocolVersion ?? CURRENT_PROTOCOL_VERSION;
    const parserManifest: ParserManifest | undefined =
      protocolVersion === 'v2-declarative-visual' ? buildParserManifest(manifest) : undefined;

    return {
      // Memory scope —— 构造 Memory adapter 时绑定
      playthroughId: this.playthroughId,
      userId: this.userId,
      chapterId: manifest.chapters[0]?.id ?? 'ch1',

      segments: allSegments,
      stateSchema: manifest.stateSchema,
      memoryConfig: manifest.memoryConfig,
      llmConfig: this.llmConfig,
      enabledTools: manifest.enabledTools,
      tokenBudget: manifest.memoryConfig.contextBudget,
      initialPrompt: manifest.initialPrompt,
      assemblyOrder: manifest.promptAssemblyOrder,
      disabledSections: manifest.disabledAssemblySections,
      // M3: 把剧本 manifest 的默认场景透传给 GameSession 初始化
      defaultScene: manifest.defaultScene,
      // V.2: 声明式视觉 IR 开关 + parser 白名单
      protocolVersion,
      parserManifest,
      // V.3: prompt 白名单插值用的角色/背景数组。v1 下传了也无害（buildEngineRules 只在 v2 分支读），
      // 所以直接无条件透传，保持字段语义跟 manifest 一致。
      characters: manifest.characters,
      backgrounds: manifest.backgrounds,
      // server 只负责把已验证 env 注入 core；core 自身不读 process.env。
      mem0ApiKey: getServerEnv().MEM0_API_KEY,
      persistence: createPlaythroughPersistence(this.playthroughId),
      tracing: createBoundTracing({
        playthroughId: this.playthroughId,
        userId: this.userId,
        // 真实的 script_versions.id（playthrough.scriptVersionId 传进来）
        scriptVersionId: this.scriptVersionId,
        kind: this.kind,
      }),
      coreEventSink: this.coreEventSink ?? undefined,
      coreEventReader: createCoreEventHistoryReader(this.playthroughId),
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
    scriptVersionId: string,
    userId: string,
    kind: string,
    llmConfig: LLMConfig,
  ): GameSessionWrapper {
    let wrapper = this.sessions.get(playthroughId);
    if (!wrapper) {
      wrapper = new GameSessionWrapper(manifest, scriptVersionId, playthroughId, userId, kind, llmConfig);
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
