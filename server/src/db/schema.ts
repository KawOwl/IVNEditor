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
// Playthroughs — 游玩记录
// ============================================================================

export const playthroughs = pgTable('playthroughs', {
  id: text('id').primaryKey(),
  playerId: text('player_id'),
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
  index('idx_playthroughs_player_id').on(table.playerId),
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
