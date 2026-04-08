/**
 * Database Schema — Drizzle ORM 定义
 *
 * 核心实体：
 *   Playthrough（游玩记录）— 玩家视角的核心实体
 *   NarrativeEntry（叙事条目）— 一条交互记录
 *
 * 数据层级：
 *   Player → Playthrough（引用 Script）→ NarrativeEntry
 */

import {
  pgTable,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';

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
// Playthroughs — 游玩记录
// ============================================================================

export const playthroughs = pgTable('playthroughs', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  scriptId: text('script_id').notNull(),
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
  index('idx_playthroughs_script_id').on(table.scriptId),
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
