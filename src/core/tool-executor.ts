/**
 * ToolExecutor — Agentic 工具系统
 *
 * 注册和执行 GM 可调用的工具。
 * 提供 AI SDK 兼容的 tool definitions。
 *
 * 必选工具（引擎自动注入）：
 *   - update_state: 更新 ScriptState
 *   - signal_input_needed: 告诉引擎该等玩家了
 *
 * 可选工具（编剧决定是否启用）：
 *   - read_state, query_changelog, pin_memory, query_memory,
 *     inject_context, list_context, advance_flow, set_mood, show_image
 *
 * NOTE: Zod v4 schemas must be wrapped with `zodSchema()` in llm-client.ts
 * before passing to AI SDK's `tool()`. The AI SDK's internal converter
 * doesn't auto-detect Zod v4's `_zod` structure.
 */

import { z } from 'zod/v4';
import type { StateStore } from './state-store';
import type { MemoryManager } from './memory';
import type { PromptSegment } from './types';

// ============================================================================
// Types
// ============================================================================

export interface ToolHandler {
  description: string;
  parameters: z.ZodType;
  execute: (args: unknown) => unknown | Promise<unknown>;
  required: boolean;  // true = 必选, false = 可选
}

export interface SignalInputOptions {
  hint?: string;
  choices?: string[];
}

export interface ToolExecutorContext {
  stateStore: StateStore;
  memory: MemoryManager;
  segments: PromptSegment[];
  onSignalInput?: (options: SignalInputOptions) => void;
  onSetMood?: (mood: string) => void;
  onShowImage?: (assetId: string) => void;
}

// ============================================================================
// Tool Definitions Factory
// ============================================================================

export function createTools(ctx: ToolExecutorContext): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};

  // --- 必选工具 ---

  tools['update_state'] = {
    description: 'Update game state variables. Pass a JSON string of key-value pairs to update.',
    parameters: z.object({
      updates_json: z.string()
        .describe('JSON string of key-value pairs to update, e.g. {"stage": 2, "turn_count_in_stage": 0}'),
    }),
    execute: (args) => {
      const { updates_json } = args as { updates_json: string };
      try {
        const patch = JSON.parse(updates_json) as Record<string, unknown>;
        ctx.stateStore.update(patch, 'llm');
        return { success: true, updated: Object.keys(patch) };
      } catch {
        return { success: false, error: 'Invalid JSON' };
      }
    },
    required: true,
  };

  tools['signal_input_needed'] = {
    description: 'Signal that the narrative has reached a point where player input is needed. Optionally provide choices for the player to pick from — the player can always type a custom response instead.',
    parameters: z.object({
      prompt_hint: z.string().optional()
        .describe('Optional hint text to display to the player'),
      choices: z.array(z.string()).optional()
        .describe('Optional list of suggested choices for the player. The player may also type freely instead of picking a choice.'),
    }),
    execute: (args) => {
      const { prompt_hint, choices } = args as { prompt_hint?: string; choices?: string[] };
      ctx.onSignalInput?.({ hint: prompt_hint, choices });
      return { success: true, waiting_for_input: true, choices_provided: choices?.length ?? 0 };
    },
    required: true,
  };

  // --- 可选工具 ---

  tools['read_state'] = {
    description: 'Read current game state. Pass specific keys to read only those fields, or omit for all.',
    parameters: z.object({
      keys: z.array(z.string()).optional()
        .describe('Specific state keys to read. Omit for full state.'),
    }),
    execute: (args) => {
      const { keys } = args as { keys?: string[] };
      if (keys && keys.length > 0) {
        return ctx.stateStore.getKeys(keys);
      }
      return ctx.stateStore.getAll();
    },
    required: false,
  };

  tools['query_changelog'] = {
    description: 'Query the state change history. Filter by variable name, turn range, or time range.',
    parameters: z.object({
      key: z.string().optional().describe('Filter by variable name'),
      turn_min: z.number().optional().describe('Minimum turn number'),
      turn_max: z.number().optional().describe('Maximum turn number'),
    }),
    execute: (args) => {
      const { key, turn_min, turn_max } = args as {
        key?: string;
        turn_min?: number;
        turn_max?: number;
      };
      return ctx.stateStore.queryChangelog({
        key,
        turnRange: turn_min !== undefined && turn_max !== undefined
          ? [turn_min, turn_max]
          : undefined,
      });
    },
    required: false,
  };

  tools['pin_memory'] = {
    description: 'Mark important content as a pinned memory that will be preserved during compression.',
    parameters: z.object({
      content: z.string().describe('The important content to remember'),
      tags: z.array(z.string()).optional().describe('Optional tags for categorization'),
    }),
    execute: (args) => {
      const { content, tags } = args as { content: string; tags?: string[] };
      const entry = ctx.memory.pin(content, tags);
      return { success: true, id: entry.id };
    },
    required: false,
  };

  tools['query_memory'] = {
    description: 'Search through past memories using keywords. Use this to verify details before referencing them.',
    parameters: z.object({
      query: z.string().describe('Search keywords'),
    }),
    execute: (args) => {
      const { query } = args as { query: string };
      const results = ctx.memory.query(query);
      return results.slice(0, 5).map((e) => ({
        turn: e.turn,
        role: e.role,
        content: e.content.slice(0, 500),
        pinned: e.pinned,
      }));
    },
    required: false,
  };

  tools['inject_context'] = {
    description: 'Load a world knowledge document into the current context. One-time injection for this turn only.',
    parameters: z.object({
      doc_id: z.string().describe('The document/segment ID to inject'),
    }),
    execute: (args) => {
      const { doc_id } = args as { doc_id: string };
      const segment = ctx.segments.find((s) => s.id === doc_id);
      if (!segment) {
        return { success: false, error: `Document "${doc_id}" not found` };
      }
      return { success: true, content: segment.content };
    },
    required: false,
  };

  tools['list_context'] = {
    description: 'List all available world knowledge documents with their IDs and descriptions.',
    parameters: z.object({}),
    execute: () => {
      return ctx.segments
        .filter((s) => s.role === 'context')
        .map((s) => ({ id: s.id, label: s.label, tokens: s.tokenCount }));
    },
    required: false,
  };

  tools['set_mood'] = {
    description: 'Set the current scene mood/atmosphere for UI rendering.',
    parameters: z.object({
      mood: z.string().describe('Mood tag like "tense", "melancholy", "peaceful"'),
    }),
    execute: (args) => {
      const { mood } = args as { mood: string };
      ctx.onSetMood?.(mood);
      return { success: true, mood };
    },
    required: false,
  };

  tools['show_image'] = {
    description: 'Display an image or CG in the UI.',
    parameters: z.object({
      asset_id: z.string().describe('The image asset ID to display'),
    }),
    execute: (args) => {
      const { asset_id } = args as { asset_id: string };
      ctx.onShowImage?.(asset_id);
      return { success: true, displayed: asset_id };
    },
    required: false,
  };

  return tools;
}

// ============================================================================
// Tool Filtering
// ============================================================================

/** Get tools filtered by enabled list. Required tools are always included. */
export function getEnabledTools(
  allTools: Record<string, ToolHandler>,
  enabledOptionalTools: string[],
): Record<string, ToolHandler> {
  const result: Record<string, ToolHandler> = {};

  for (const [name, handler] of Object.entries(allTools)) {
    if (handler.required || enabledOptionalTools.includes(name)) {
      result[name] = handler;
    }
  }

  return result;
}

// ============================================================================
// AI SDK Tool Conversion
// ============================================================================

/**
 * Convert tool handlers to AI SDK compatible tool definitions.
 * Returns an object compatible with the `tools` parameter of `streamText`.
 */
export function toAISDKTools(
  tools: Record<string, ToolHandler>,
): Record<string, { description: string; parameters: z.ZodType; execute: (args: unknown) => unknown | Promise<unknown> }> {
  const result: Record<string, {
    description: string;
    parameters: z.ZodType;
    execute: (args: unknown) => unknown | Promise<unknown>;
  }> = {};

  for (const [name, handler] of Object.entries(tools)) {
    result[name] = {
      description: handler.description,
      parameters: handler.parameters,
      execute: handler.execute,
    };
  }

  return result;
}
