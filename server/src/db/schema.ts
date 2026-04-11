/**
 * Database Schema — Drizzle ORM 定义
 *
 * 核心实体：
 *   User → Script → ScriptVersion → Playthrough → NarrativeEntry
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
  boolean,
  jsonb,
  timestamp,
  index,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { ScriptManifest } from '../../../src/core/types';

// ============================================================================
// Users — 玩家用户表
// ============================================================================

/**
 * 统一的用户表：匿名和注册用户都在这里。
 * - 匿名用户：username / password_hash 都为 null
 * - 注册用户：username 非 null
 * 通过 username IS NOT NULL 判断是否注册。
 * 从匿名到注册只需 UPDATE 同一行，user.id 不变，playthroughs 自动继承。
 */
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  username: text('username').unique(), // NULL = 未注册（匿名）
  passwordHash: text('password_hash'), // NULL = 未注册
  displayName: text('display_name'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
});

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
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
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
  // 注意：FK references() 暂时关闭 —— 6.1 阶段 service/routes 还没接 scripts
  // + script_versions 路由，script_versions 表为空。真正的 FK 约束会在 6.2
  // 做完 "后端 scripts + script-versions 路由" 后补上。
  // TODO(6.2): add .references(() => scriptVersions.id)
  scriptVersionId: text('script_version_id').notNull(),
  // 'production' | 'playtest'
  // production = 玩家正式游玩；playtest = 编剧在编辑器里试玩
  kind: text('kind').notNull(),
  title: text('title'),
  chapterId: text('chapter_id').notNull(),
  status: text('status').notNull().default('idle'),
  turn: integer('turn').notNull().default(0),
  stateVars: jsonb('state_vars').$type<Record<string, unknown>>(),
  memoryEntries: jsonb('memory_entries').$type<unknown[]>(),
  memorySummaries: jsonb('memory_summaries').$type<string[]>(),
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
]);

// ============================================================================
// Narrative Entries — 叙事条目
// ============================================================================

export const narrativeEntries = pgTable('narrative_entries', {
  id: text('id').primaryKey(),
  playthroughId: text('playthrough_id')
    .notNull()
    .references(() => playthroughs.id, { onDelete: 'cascade' }),
  role: text('role').notNull(), // 'generate' | 'receive' | 'system'
  content: text('content').notNull(),
  reasoning: text('reasoning'),
  toolCalls: jsonb('tool_calls').$type<unknown[]>(),
  finishReason: text('finish_reason'),
  orderIdx: integer('order_idx').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('idx_narrative_entries_playthrough_id').on(table.playthroughId),
  index('idx_narrative_entries_order_idx').on(table.playthroughId, table.orderIdx),
]);
