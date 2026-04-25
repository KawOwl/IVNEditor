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

export const focusTagsSchema = z.object({
  scene: z.string().optional(),
  chars: z.array(z.string()).optional(),
  stage: z.string().optional(),
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
  focusTags: focusTagsSchema.optional(),
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

export const memoryConfigSchema = z.object({
  contextBudget: z.number().int().positive(),
  compressionThreshold: z.number().int().positive(),
  recencyWindow: z.number().int().positive(),
  compressionHints: z.string().optional(),
  // Memory adapter 选择 —— 见 packages/core/src/memory/factory.ts
  provider: z.enum(['legacy', 'llm-summarizer', 'mem0']).optional(),
  providerOptions: z.record(z.string(), z.unknown()).optional(),
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
// VN Narrative — XML-lite 叙事协议的结构化类型（M3）
// ============================================================================

export const spriteStateSchema = z.object({
  id: z.string(),
  emotion: z.string(),
  position: z.enum(['left', 'center', 'right']).optional(),
});

export const sceneStateSchema = z.object({
  background: z.string().nullable(),
  sprites: z.array(spriteStateSchema),
});

export const participationFrameSchema = z.object({
  speaker: z.string(),
  addressee: z.array(z.string()).optional(),
  overhearers: z.array(z.string()).optional(),
  eavesdroppers: z.array(z.string()).optional(),
});

export const sentenceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('narration'),
    text: z.string(),
    sceneRef: sceneStateSchema,
    turnNumber: z.number().int().nonnegative(),
    index: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('dialogue'),
    text: z.string(),
    pf: participationFrameSchema,
    sceneRef: sceneStateSchema,
    turnNumber: z.number().int().nonnegative(),
    index: z.number().int().nonnegative(),
    truncated: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('scene_change'),
    scene: sceneStateSchema,
    transition: z.enum(['fade', 'cut', 'dissolve']).optional(),
    turnNumber: z.number().int().nonnegative(),
    index: z.number().int().nonnegative(),
  }),
]);

// ============================================================================
// Script Assets — 剧本美术资产引用（M3 占位，M4 接 OSS）
// ============================================================================

export const spriteAssetSchema = z.object({
  id: z.string(),
  assetUrl: z.string().optional(),
  label: z.string().optional(),
});

export const characterAssetSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  sprites: z.array(spriteAssetSchema),
});

export const backgroundAssetSchema = z.object({
  id: z.string(),
  assetUrl: z.string().optional(),
  label: z.string().optional(),
});

// ============================================================================
// Tool args schemas for Scene-management tools（供 tool-catalog 复用）
// ============================================================================

export const changeSceneArgsSchema = z.object({
  background: z.string().optional(),
  sprites: z.array(spriteStateSchema).optional(),
  transition: z.enum(['fade', 'cut', 'dissolve']).optional(),
});

export const changeSpriteArgsSchema = z.object({
  character: z.string(),
  emotion: z.string(),
  position: z.enum(['left', 'center', 'right']).optional(),
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
