/**
 * Zod validation schemas for runtime data validation.
 * Mirrors the TypeScript interfaces in types.ts.
 */

import { z } from 'zod/v4';

// ============================================================================
// Flow Graph（可视化参考，不做运行时路由）
// ============================================================================

export const flowNodeSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  promptSegments: z.array(z.string()),
});

export const flowEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string().optional(),
});

export const flowGraphSchema = z.object({
  id: z.string(),
  label: z.string(),
  nodes: z.array(flowNodeSchema),
  edges: z.array(flowEdgeSchema),
});

// ============================================================================
// Prompt Segments
// ============================================================================

export const injectionRuleSchema = z.object({
  description: z.string(),
  condition: z.string(),
});

export const promptSegmentSchema = z.object({
  id: z.string(),
  label: z.string(),
  content: z.string(),
  contentHash: z.string(),
  type: z.enum(['content', 'logic']),
  sourceDoc: z.string(),
  sourceRange: z.tuple([z.number(), z.number()]).optional(),
  role: z.enum(['system', 'context', 'draft']),
  priority: z.number(),
  injectionRule: injectionRuleSchema.optional(),
  tokenCount: z.number().int().nonnegative(),
});

// ============================================================================
// State Schema
// ============================================================================

export const stateVariableSchema = z.object({
  name: z.string(),
  type: z.enum(['number', 'string', 'boolean', 'array', 'object']),
  initial: z.unknown(),
  description: z.string(),
  range: z.object({
    min: z.number().optional(),
    max: z.number().optional(),
  }).optional(),
});

export const stateSchemaSchema = z.object({
  variables: z.array(stateVariableSchema),
});

// ============================================================================
// Memory Config
// ============================================================================

export const crossChapterConfigSchema = z.object({
  inherit: z.array(z.string()),
  exclude: z.array(z.string()),
});

export const memoryConfigSchema = z.object({
  contextBudget: z.number().int().positive(),
  compressionThreshold: z.number().int().positive(),
  recencyWindow: z.number().int().positive(),
  compressionHints: z.string().optional(),
  crossChapterInheritance: crossChapterConfigSchema.optional(),
});

// ============================================================================
// Script Manifest
// ============================================================================

export const chapterManifestSchema = z.object({
  id: z.string(),
  label: z.string(),
  flowGraph: flowGraphSchema,
  segments: z.array(promptSegmentSchema),
  inheritsFrom: z.string().optional(),
});

export const scriptManifestSchema = z.object({
  id: z.string(),
  version: z.string(),
  label: z.string(),
  chapters: z.array(chapterManifestSchema),
  stateSchema: stateSchemaSchema,
  memoryConfig: memoryConfigSchema,
  enabledTools: z.array(z.string()),
  initialPrompt: z.string().optional(),
});

// ============================================================================
// Runtime State
// ============================================================================

export const memoryEntrySchema = z.object({
  id: z.string(),
  turn: z.number().int().nonnegative(),
  role: z.enum(['generate', 'receive', 'system']),
  content: z.string(),
  tokenCount: z.number().int().nonnegative(),
  timestamp: z.number(),
  tags: z.array(z.string()).optional(),
  pinned: z.boolean().optional(),
});

export const changelogEntrySchema = z.object({
  id: z.string(),
  turn: z.number().int().nonnegative(),
  timestamp: z.number(),
  key: z.string(),
  previousValue: z.unknown(),
  newValue: z.unknown(),
  source: z.enum(['llm', 'system']),
});

// 注：saveDataSchema 已随 v2.5 后端持久化上线而废弃（对应类型 SaveData
// 也已从 types.ts 删除）。前端 IndexedDB 存档路径不再存在。
