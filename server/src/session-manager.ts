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
import type { GameSessionConfig, RestoreConfig, ProtocolVersion } from '../../src/core/game-session';
import type { ScriptManifest, PromptSegment } from '../../src/core/types';
import type { LLMConfig } from '../../src/core/llm-client';
import { buildParserManifest, type ParserManifest } from '../../src/core/narrative-parser-v2';
import { createWebSocketEmitter } from './ws-session-emitter';
import { createPlaythroughPersistence } from './services/playthrough-persistence';
import { createNarrativeHistoryReader } from './services/narrative-reader';
import { createBoundTracing } from './tracing';

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

  attachWebSocket(ws: WS): void {
    this.clearTTL();

    // 停掉旧 GameSession，防止 "双活" 竞态：
    // 旧 session 可能还在 generate 途中写 DB，新 session 恢复后并发写
    // 会导致 narrative_entries 的 orderIdx 重复/乱序。
    if (this.gameSession) {
      this.gameSession.stop();
      this.gameSession = null;
    }

    this.ws = ws;
    // 编剧试玩（playtest）启用 debug 数据推送，玩家正式游玩不推
    const emitter = createWebSocketEmitter(ws, {
      enableDebug: this.kind === 'playtest',
    });
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
      // mem0 key 从 base 带过来（base 已经从 env 读好了）
      mem0ApiKey: base.mem0ApiKey,
      // 🐛 FIX 2026-04-24（session 85a8c5c0 / 1e5f07db reload 100% 丢进度复盘）：
      // narrativeReader 原来漏在 restore 路径没传，createMemory 拿到 reader=undefined，
      // adapter 的 getRecentAsMessages 每次返回空 —— reload 后 LLM 看不到任何历史，
      // assembler 塞 initialPrompt 兜底，LLM 被诱导"从头开始"。
      //
      // start() 走 buildConfig() 整包传所以没踩；restore() 手工挑字段漏了这个。
      // 下次新增 GameSessionConfig 字段要警惕这里同步更新，或者干脆直接 `...base`。
      narrativeReader: base.narrativeReader,
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
      currentScene: snapshot.currentScene as import('../../src/core/types').SceneState | null | undefined,
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

    // V.2：parser 分叉的触发键。
    //   - manifest.protocolVersion 缺省 → 'v1-tool-call'（老剧本 / 未迁移剧本）
    //   - 'v2-declarative-visual' → 启用 parser-v2，不再注册 change_scene 等工具
    const protocolVersion: ProtocolVersion = manifest.protocolVersion ?? 'v1-tool-call';
    // parserManifest 只有 v2 需要。v1 下计算也无害但多余，所以按需算。
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
      // mem0 adapter 需要 API key —— 从 env 读后注入。没配也没事，只有 provider='mem0' 时 factory 才检查。
      mem0ApiKey: process.env.MEM0_API_KEY,
      persistence: createPlaythroughPersistence(this.playthroughId),
      tracing: createBoundTracing({
        playthroughId: this.playthroughId,
        userId: this.userId,
        // 真实的 script_versions.id（playthrough.scriptVersionId 传进来）
        scriptVersionId: this.scriptVersionId,
        kind: this.kind,
      }),
      // Memory Refactor v2：memory adapter 通过 reader 从 canonical
      // narrative_entries 读历史，不再持有 entries 副本。
      narrativeReader: createNarrativeHistoryReader(this.playthroughId),
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
