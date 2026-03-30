/**
 * Zod validation schemas for runtime data validation.
 * Mirrors the TypeScript interfaces in types.ts.
 */

import { z } from 'zod/v4';

// ============================================================================
// Flow Graph
// ============================================================================

export const nodeTypeSchema = z.enum(['scene', 'input', 'compress', 'state-update', 'checkpoint']);

export const sceneNodeConfigSchema = z.object({
  type: z.literal('scene'),
  promptSegments: z.array(z.string()),
  auto: z.boolean(),
  model: z.string().optional(),
  maxTokens: z.number().int().positive().optional(),
});

export const inputNodeConfigSchema = z.object({
  type: z.literal('input'),
  inputType: z.enum(['freetext', 'choice']),
  choices: z.union([z.array(z.string()), z.object({ fromState: z.string() })]).optional(),
  saveToState: z.string().optional(),
  promptHint: z.string().optional(),
});

export const compressNodeConfigSchema = z.object({
  type: z.literal('compress'),
  hintPrompt: z.string().optional(),
  pinItems: z.array(z.string()).optional(),
});

export const stateUpdateNodeConfigSchema = z.object({
  type: z.literal('state-update'),
  updates: z.record(z.string(), z.unknown()),
});

export const checkpointNodeConfigSchema = z.object({
  type: z.literal('checkpoint'),
  label: z.string().optional(),
});

export const nodeConfigSchema = z.discriminatedUnion('type', [
  sceneNodeConfigSchema,
  inputNodeConfigSchema,
  compressNodeConfigSchema,
  stateUpdateNodeConfigSchema,
  checkpointNodeConfigSchema,
]);

export const flowNodeSchema = z.object({
  id: z.string(),
  type: nodeTypeSchema,
  label: z.string(),
  config: nodeConfigSchema,
});

export const flowEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  condition: z.string().optional(),
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
  role: z.enum(['system', 'context']),
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
  updatedBy: z.enum(['llm', 'flow', 'player']),
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
});

// ============================================================================
// Runtime State
// ============================================================================

export const memoryEntrySchema = z.object({
  id: z.string(),
  turn: z.number().int().nonnegative(),
  role: z.enum(['gm', 'pc', 'system']),
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
  source: z.enum(['llm', 'flow', 'player', 'system']),
});

export const saveDataSchema = z.object({
  version: z.string(),
  scriptId: z.string(),
  scriptVersion: z.string(),
  timestamp: z.number(),
  progress: z.object({
    currentChapterId: z.string(),
    currentNodeId: z.string(),
    nodePhase: z.enum(['pending', 'generating', 'waiting-input', 'completed']),
    loopCounters: z.record(z.string(), z.number()),
    visitedNodes: z.array(z.string()),
    totalTurns: z.number().int().nonnegative(),
  }),
  scriptState: z.object({
    vars: z.record(z.string(), z.unknown()),
  }),
  memory: z.object({
    entries: z.array(memoryEntrySchema),
    summaries: z.array(z.string()),
    watermark: z.number().int().nonnegative(),
    inheritedSummary: z.string().optional(),
  }),
  changelog: z.array(changelogEntrySchema),
  activeSegmentIds: z.array(z.string()),
  inheritanceSnapshot: z.object({
    fromChapter: z.string(),
    toChapter: z.string(),
    timestamp: z.number(),
    fields: z.record(z.string(), z.unknown()),
    summary: z.string(),
  }).optional(),
});
