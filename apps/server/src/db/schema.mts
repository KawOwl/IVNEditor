/**
 * Database Schema — Drizzle ORM 定义
 *
 * 核心实体：
 *   User → Script → ScriptVersion → Playthrough → CoreEventEnvelope
 *
 * Script 层级剧本身份与版本分离：
 *   - scripts：剧本身份 + 跨版本稳定的元数据（label/description）
 *   - script_versions：每次编剧保存触发一个版本（draft/published/archived）
 *   - playthroughs 指向具体的 script_version，不直接引用 script
 *
 * 这样：
 *   (1) 旧 playthroughs 的 manifest 永远冻结在创建时那个版本，剧本后续改版不会意外破坏
 *   (2) 编剧可以回看所有历史版本
 *   (3) 编剧试玩和玩家正式游玩都走同一套 playthrough 机制，用 kind 字段区分
 */

import { sql } from 'drizzle-orm';
import {
  pgTable,
  text,
  integer,
  bigint,
  boolean,
  jsonb,
  timestamp,
  index,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { ScriptManifest } from '@ivn/core/types';
import type { CoreEvent } from '@ivn/core/game-session';

// ============================================================================
// Roles — 用户角色表
// ============================================================================

/**
 * 用户角色定义，供 users.role_id FK 引用。
 *
 * 初始两个角色（seed）:
 *   - admin: 管理员，完全访问权限，编辑/发布剧本
 *   - user:  普通用户，默认角色（包括匿名 + 注册玩家）
 *
 * 以后可以按需加角色（比如 'reviewer'、'support'），不需要改 users schema。
 */
export const roles = pgTable('roles', {
  id: text('id').primaryKey(),            // slug，例 'admin' / 'user'
  name: text('name').notNull(),           // 显示名，例 '管理员' / '普通用户'
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// ============================================================================
// Users — 用户表
// ============================================================================

/**
 * 统一的用户表：匿名、注册玩家、管理员都在这里。
 *
 * - 匿名用户：username / password_hash 都为 null；role_id = 'user'
 * - 注册玩家（未来做登录）：username 非 null + password_hash；role_id = 'user'
 * - 管理员：username 非 null + password_hash；role_id = 'admin'
 *   管理员通过 seed 脚本从 env 一次性创建（见 scripts/seed-admin.mts）
 *
 * v2.6 之前 admin 走单独的 HMAC token 认证、不进 users 表。6.2b 合并进来：
 * admin 和玩家用同一套 user_sessions token，区别只在 role_id='admin'。
 */
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  username: text('username').unique(), // NULL = 未注册（匿名）；当前 PFB.2 注册主键改用 email，username 留作未来"显示名"
  /**
   * 注册玩家邮箱，唯一。匿名 / admin 可为 NULL。
   * PFB.2 起作为注册主键（email + passwordHash 同步从 NULL 升级为非空）。
   */
  email: text('email').unique(),
  passwordHash: text('password_hash'), // NULL = 未设密码（匿名 / 可登录性由此判定）
  displayName: text('display_name'),
  roleId: text('role_id')
    .notNull()
    .default('user')
    .references(() => roles.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('idx_users_role').on(table.roleId),
]);

// ============================================================================
// User Sessions — Auth 会话（DB 映射 sessionId → userId）
// ============================================================================

/**
 * 客户端只拿 opaque 的 sessionId（= user_sessions.id），
 * 服务端用 sessionId 查到 user_id。客户端永远拿不到 user_id。
 *
 * 匿名 session 默认 1 年过期，后续每次请求滑动续期（更新 last_used_at 和 expires_at）。
 */
export const userSessions = pgTable('user_sessions', {
  id: text('id').primaryKey(), // 随机 UUID，客户端 localStorage 里存的就是这个
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (table) => [
  index('idx_user_sessions_user_id').on(table.userId),
  index('idx_user_sessions_expires').on(table.expiresAt),
]);

// ============================================================================
// LLM Configs — LLM 连接信息（多套命名配置）
// ============================================================================

/**
 * v2.7 引入：把 LLM 连接配置从"前端 localStorage + 后端单文件 JSON"迁到
 * postgres，支持多套命名配置。每个 script 可以指定 production 用哪套，
 * 每个 playthrough 创建时固化当时用的那套（不可变历史）。
 *
 * API key 明文存 text 列 —— 与现有 /api/config/llm 的处理一致，只对
 * admin 开放读取。
 */
export const llmConfigs = pgTable('llm_configs', {
  id: text('id').primaryKey(),
  /** 用户可见名字，例如 "DeepSeek Chat"、"Claude Sonnet 4.5" */
  name: text('name').notNull(),
  /** 'openai-compatible' | 'anthropic' */
  provider: text('provider').notNull(),
  baseUrl: text('base_url').notNull(),
  apiKey: text('api_key').notNull(),
  model: text('model').notNull(),
  /** 本配置默认 max output tokens（AI 改写、generate 都用） */
  maxOutputTokens: integer('max_output_tokens').notNull().default(8192),
  /**
   * DeepSeek V4 thinking 模式开关。
   *   null  → 不传 thinking 字段，让模型走 provider 默认（V4 系列默认 enabled）
   *   true  → 显式传 thinking:{type:'enabled'}
   *   false → 显式传 thinking:{type:'disabled'}（escape hatch：绕开
   *           "reasoning_content must be passed back" 的回放要求）
   * 对非 DeepSeek 模型字段设了也不生效（provider 层会忽略）。
   */
  thinkingEnabled: boolean('thinking_enabled'),
  /**
   * reasoning 强度，仅 thinking 模式生效。
   *   null / 'high' / 'max'。低于 'high' 的值 DeepSeek 端会静默 map 到 'high'。
   * 作为 providerOptions.openaiCompatible.reasoningEffort 传下去。
   */
  reasoningEffort: text('reasoning_effort'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// ============================================================================
// Scripts — 剧本身份（跨版本稳定的元数据）
// ============================================================================

/**
 * 每个 script 对应一个剧本项目。label / description 是"剧本级"的元数据，
 * 不随版本迭代而变化——编剧改名改简介就是改这里，不产生新版本。
 * 版本相关（manifest 内容、发布状态）全部在 script_versions 表。
 */
export const scripts = pgTable('scripts', {
  id: text('id').primaryKey(),
  authorUserId: text('author_user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  description: text('description'),
  /** 玩家玩这个剧本时用哪套 LLM。null → 由 playthrough 创建逻辑按 fallback 链兜底 */
  productionLlmConfigId: text('production_llm_config_id')
    .references(() => llmConfigs.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  // 软删除时刻：null = 活跃，非 null = 已软删（deletedAt 即被删时间）。
  // 选软删而非硬删的原因：playthroughs.script_version_id 没 ON DELETE
  // CASCADE，硬删 script → cascade 删 script_versions → 撞 FK violation
  // 全 tx rollback。软删完全 sidestep 这条链，且保留 Langfuse trace 上的
  // playthroughs 历史 + 误删可手动 SQL 恢复。
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => [
  index('idx_scripts_author').on(table.authorUserId),
]);

// ============================================================================
// Script Versions — 剧本版本（draft / published / archived）
// ============================================================================

/**
 * 每次编剧"保存"都会创建一个新版本（除非内容和上一个版本完全一致，此时
 * 后端按 content_hash 去重返回已有 version）。
 *
 * 状态机：
 *   draft → published：编剧点"发布"，原 published 版本自动转 archived
 *   published → archived：被新的 published 取代
 *   archived 只读，不能再转换
 *
 * 硬约束：同一个 script 同时最多只能有一个 status='published' 的版本
 * （通过 partial unique index 实现）。
 */
export const scriptVersions = pgTable('script_versions', {
  id: text('id').primaryKey(),
  scriptId: text('script_id')
    .notNull()
    .references(() => scripts.id, { onDelete: 'cascade' }),
  // 机器用：每个 script 内单调递增，便于排序、URL 引用
  versionNumber: integer('version_number').notNull(),
  // 人看：可选的自由文本 label，纯展示不参与唯一性（例："v1.0 首发" / "修 NPC 对话"）
  label: text('label'),
  // 'draft' | 'published' | 'archived'
  status: text('status').notNull(),
  // 完整 ScriptManifest 快照
  manifest: jsonb('manifest').$type<ScriptManifest>().notNull(),
  // sha256(manifest JSON)，用于 save 去重
  contentHash: text('content_hash').notNull(),
  // 版本说明（类似 git commit message，编剧可选填）
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
}, (table) => [
  // 同 script 的 version_number 必须唯一
  unique('uniq_script_version_number').on(table.scriptId, table.versionNumber),
  // 同 script 内最多一个 published（partial unique index）
  uniqueIndex('idx_one_published_per_script')
    .on(table.scriptId)
    .where(sql`status = 'published'`),
  // 查某个 script 的所有版本，倒序列出
  index('idx_script_versions_script').on(table.scriptId, table.versionNumber),
]);

// ============================================================================
// Playthroughs — 游玩记录
// ============================================================================

/**
 * 指向具体的 script_version，不直接引用 script。这样：
 *   - 老 playthroughs 的 manifest 永远是创建时那个版本，作者改版不会错乱 state
 *   - 编辑器试玩和玩家正式游玩用同一张表，kind 字段区分
 */
export const playthroughs = pgTable('playthroughs', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  scriptVersionId: text('script_version_id')
    .notNull()
    .references(() => scriptVersions.id),
  /**
   * 创建 playthrough 时固化的 LLM config id。即便后来 script 的
   * production_llm_config_id 变了、或者这个 llm_config 被 admin 编辑，
   * 这条 playthrough 继续指向"创建时那一份"。
   *
   * 注意 onDelete: 'restrict' —— 被引用的 config 不能直接 DELETE，
   * 服务端删除接口会先查 playthroughs 反向引用。
   */
  llmConfigId: text('llm_config_id')
    .notNull()
    .references(() => llmConfigs.id, { onDelete: 'restrict' }),
  // 'production' | 'playtest'
  // production = 玩家正式游玩；playtest = 编剧在编辑器里试玩
  kind: text('kind').notNull(),
  title: text('title'),
  chapterId: text('chapter_id').notNull(),
  status: text('status').notNull().default('idle'),
  turn: integer('turn').notNull().default(0),
  stateVars: jsonb('state_vars').$type<Record<string, unknown>>(),
  /**
   * 记忆模块抽象重构后（0009_memory_snapshot）：单列 opaque JSONB。
   * 内容格式由 Memory adapter 的 kind 字段自解释：
   *   - legacy:    { kind:'legacy-v2', summaries, pinned, compressedUpTo }
   *   - mem0:      { kind:'mem0-v1', ... }（Phase 3 定义）
   * 未来切换 adapter 时 DB schema 不再变。
   */
  memorySnapshot: jsonb('memory_snapshot').$type<Record<string, unknown>>(),
  /**
   * VN 模式当前场景快照。当前运行协议由声明式视觉标签演进，
   * 结构为 { background: string | null, sprites: SpriteState[] }。
   * 断线重连时前端用此恢复视觉状态。
   */
  currentScene: jsonb('current_scene').$type<{
    background: string | null;
    sprites: Array<{ id: string; emotion: string; position?: string }>;
  }>(),
  /**
   * VN 模式当前句子索引（M3）。用 M1/M2 的 Sentence[] 指针恢复玩家读到的位置。
   * null = 尚未开始游玩。
   */
  sentenceIndex: integer('sentence_index'),
  inputHint: text('input_hint'),
  inputType: text('input_type').notNull().default('freetext'),
  choices: jsonb('choices').$type<string[]>(),
  preview: text('preview'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  archived: boolean('archived').notNull().default(false),
}, (table) => [
  index('idx_playthroughs_user_id').on(table.userId),
  index('idx_playthroughs_script_version_id').on(table.scriptVersionId),
  index('idx_playthroughs_kind_user').on(table.kind, table.userId),
  index('idx_playthroughs_updated_at').on(table.updatedAt),
  index('idx_playthroughs_llm_config_id').on(table.llmConfigId),
]);

// ============================================================================
// Core Event Envelopes — runtime event log
// ============================================================================

export const coreEventEnvelopes = pgTable('core_event_envelopes', {
  id: text('id').primaryKey(),
  playthroughId: text('playthrough_id')
    .notNull()
    .references(() => playthroughs.id, { onDelete: 'cascade' }),
  schemaVersion: integer('schema_version').notNull(),
  sequence: integer('sequence').notNull(),
  occurredAt: bigint('occurred_at', { mode: 'number' }).notNull(),
  event: jsonb('event').$type<CoreEvent>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('idx_core_event_envelopes_playthrough_id').on(table.playthroughId),
  unique('uniq_core_event_envelope_sequence').on(table.playthroughId, table.sequence),
]);

// ============================================================================
// Script Assets — VN 美术资产（M4）
// ============================================================================
//
// 资产跟 script 走（owner = script.author_user_id），删剧本级联删。
// storage_key 是 S3 里的 object key（生产是阿里云 OSS，dev 是 MinIO）。
// manifest 里的 `assetUrl` 字段存 `/api/assets/<storage_key>`，前端 <img src> 直接可用。
export const scriptAssets = pgTable('script_assets', {
  id: text('id').primaryKey(),
  scriptId: text('script_id')
    .notNull()
    .references(() => scripts.id, { onDelete: 'cascade' }),
  /** 'background' | 'sprite' —— 目前仅用于分类展示，后端不强制校验用途 */
  kind: text('kind').notNull(),
  /** S3 object key，形如 "scripts/<sid>/<uuid>.png"；unique 全局避重 */
  storageKey: text('storage_key').notNull().unique(),
  /** 上传时的原文件名（诊断用，非必须） */
  originalName: text('original_name'),
  /** 上传 request 带的 Content-Type（不做白名单） */
  contentType: text('content_type'),
  /** 文件大小（诊断 / 审计） */
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('idx_script_assets_script').on(table.scriptId),
]);

// ============================================================================
// User Profiles — 注册时填的 6 题用户画像（PFB.2）
// ============================================================================
//
// 一对一关系（userId 是 PK 也是 FK），用 cascade 删 user 时同步删画像。
// 字段值是中文选项原文（hobbies 是 1-2 个原文字符串数组，jsonb 跟现有
// playthroughs.choices 风格一致），后端用 zod enum 严格校验防漂移。
// affiliation 是 free text（单位/学号），最大 200 字符在 route 层 zod 限。
export const userProfiles = pgTable('user_profiles', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** Q1 单位 / 学号（free text） */
  affiliation: text('affiliation').notNull(),
  /** Q2 性别 */
  gender: text('gender').notNull(),
  /** Q3 年级 */
  grade: text('grade').notNull(),
  /** Q4 专业大类 */
  major: text('major').notNull(),
  /** Q5 月娱乐消费区间 */
  monthlyBudget: text('monthly_budget').notNull(),
  /** Q6 课余爱好（1-2 选） */
  hobbies: jsonb('hobbies').$type<string[]>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// ============================================================================
// Feedback — 玩家游玩内问卷反馈（PFB.1）
// ============================================================================
//
// 玩家页右上角"反馈"按钮的 5 题问卷答案。直接落自家 DB，不再走外部表单。
// 选项原文（中文）直接存 text 列，简化前后端；后端用 zod enum 严格校验防漂移。
// q4 选 '其他' 时 q4_other 必填（非空 trim 后非空字符串），其余情况下 q4_other 为 null。
// playthroughId 可空：玩家在没启动游戏时也允许反馈；剧本被软删时反馈记录保留。
export const feedback = pgTable('feedback', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** 提交时的当前 playthrough（如果有）。剧本删除不级联删反馈，置 null 即可 */
  playthroughId: text('playthrough_id')
    .references(() => playthroughs.id, { onDelete: 'set null' }),
  /** Q1 看剧情偏好 */
  q1: text('q1').notNull(),
  /** Q2 互动小说痛点 */
  q2: text('q2').notNull(),
  /** Q3 《潜台词》最吸引点 */
  q3: text('q3').notNull(),
  /** Q4 付费过的内容（含 '其他' 选项） */
  q4: text('q4').notNull(),
  /** Q4 选 '其他' 时的自填内容（其它选项时为 null） */
  q4Other: text('q4_other'),
  /** Q5 AI 接受度 */
  q5: text('q5').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('idx_feedback_user_id').on(table.userId),
  index('idx_feedback_playthrough_id').on(table.playthroughId),
  index('idx_feedback_created_at').on(table.createdAt),
]);

// ============================================================================
// Memory deletion annotation tables（ANN.1 Step 1）
// ============================================================================
//
// 见 docs/refactor/ann-1-memory-deletion-annotation-plan.md。
//
// turn_memory_retrievals      —— 每次 Memory.retrieve 的结果落盘
// memory_deletion_annotations —— 用户标记"忘掉"某条 memory 的标注
//
// 不改 playthroughs.memory_snapshot：tombstone 在 retrieve 边界做 filter。

/**
 * MemoryEntry 的 JSON 兼容子集，避开 core 类型在 server schema 引入的循环。
 * 字段对齐 packages/core/src/types.mts 的 MemoryEntry。
 */
export interface MemoryEntrySnapshot {
  id: string;
  turn: number;
  role: 'generate' | 'receive' | 'system';
  content: string;
  tokenCount: number;
  timestamp: number;
  tags?: string[];
  pinned?: boolean;
}

export const turnMemoryRetrievals = pgTable('turn_memory_retrievals', {
  id: text('id').primaryKey(),
  playthroughId: text('playthrough_id')
    .notNull()
    .references(() => playthroughs.id, { onDelete: 'cascade' }),
  turn: integer('turn').notNull(),
  /** 关联 batch_id（CoreEvent batchId）；context-assembly 早于 batch 分配时为 null */
  batchId: text('batch_id'),
  /** 'context-assembly' | 'tool-call' */
  source: text('source').notNull(),
  query: text('query').notNull().default(''),
  /** MemoryEntry[] 完整快照（含 stable id / role / content / pinned / tags） */
  entries: jsonb('entries').$type<MemoryEntrySnapshot[]>().notNull(),
  /** adapter 返回的 summary 文本（mem0 / memorax 时是相关记忆 bullet list） */
  summary: text('summary').notNull().default(''),
  /** adapter meta（mem0 topK / scores / error 等）*/
  meta: jsonb('meta').$type<Record<string, unknown>>(),
  retrievedAt: timestamp('retrieved_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('idx_turn_memory_retrievals_playthrough_turn').on(table.playthroughId, table.turn),
  index('idx_turn_memory_retrievals_batch_id').on(table.playthroughId, table.batchId),
]);

/**
 * reason_code 枚举（runtime 校验在 service / op 层做，这里只声明）：
 *   'character-broken' | 'memory-confused' | 'logic-error' | 'other'
 */
export const memoryDeletionAnnotations = pgTable('memory_deletion_annotations', {
  id: text('id').primaryKey(),
  turnMemoryRetrievalId: text('turn_memory_retrieval_id')
    .notNull()
    .references(() => turnMemoryRetrievals.id, { onDelete: 'restrict' }),
  /** 冗余字段，便于按 playthrough 直接聚合查询 */
  playthroughId: text('playthrough_id')
    .notNull()
    .references(() => playthroughs.id, { onDelete: 'cascade' }),
  memoryEntryId: text('memory_entry_id').notNull(),
  /** 删除时刻完整 MemoryEntry 内容（防止源条目漂移 / 被压缩 / 被淘汰）*/
  memoryEntrySnapshot: jsonb('memory_entry_snapshot').$type<MemoryEntrySnapshot>().notNull(),
  reasonCode: text('reason_code').notNull(),
  /** 仅 reason_code='other' 时填，玩家自由文本（短）*/
  reasonText: text('reason_text'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  /** 5s 撤销窗内取消填值；NULL 表示该标注 active */
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
}, (table) => [
  index('idx_memory_deletion_annotations_playthrough_created')
    .on(table.playthroughId, table.createdAt),
  index('idx_memory_deletion_annotations_memory_entry_id').on(table.memoryEntryId),
  // 同一 (playthrough, memory_entry_id) 只能有一条 active（cancelled_at IS NULL）的标注。
  // partial unique index — drizzle-kit schema 不支持 WHERE 子句，由 migration SQL 手写。
]);

// ============================================================================
// Bug Reports — 游玩内 bug 反馈（PFB.3）
// ============================================================================
//
// 跟 feedback 表平行：同一玩家可以同时提"问卷"和"bug 反馈"。
// 不存截图——playthroughId 已能 join 出完整 trace 用于重放。
// 后端要求 requireNonAnonymous，匿名用户拒（前端 RegistrationGate 已经
// 全屏拦截，这一层是 defense-in-depth）。
export const bugReports = pgTable('bug_reports', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** 提交时的当前 playthrough（可空：玩家在没启动游戏时也能反馈 bug） */
  playthroughId: text('playthrough_id')
    .references(() => playthroughs.id, { onDelete: 'set null' }),
  /** 提交时的 turn（与 playthroughId 配对定位 trace 重放点；playthroughId 为 null 时也为 null） */
  turn: integer('turn'),
  /** bug 描述自由文本，最大长度由 route 层 zod 限（5000 char） */
  description: text('description').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('idx_bug_reports_user_id').on(table.userId),
  index('idx_bug_reports_playthrough_id').on(table.playthroughId),
  index('idx_bug_reports_created_at').on(table.createdAt),
]);
