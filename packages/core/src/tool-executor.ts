/**
 * ToolExecutor — Agentic 工具运行时
 *
 * 负责：为每个工具提供参数 Zod schema 和 execute 函数。
 *
 * 工具的名称、描述、必选/可选分类由 `tool-catalog.ts` 统一维护——
 * 本文件只关心运行时执行逻辑，不重复定义描述文本。
 *
 * 新增工具流程：
 *   1. 在 tool-catalog.ts 加 ToolMetadata entry
 *   2. 在本文件的 createTools() 里加对应的 parameters + execute
 *
 * NOTE: Zod v4 schemas must be wrapped with `zodSchema()` in llm-client.ts
 * before passing to AI SDK's `tool()`. The AI SDK's internal converter
 * doesn't auto-detect Zod v4's `_zod` structure.
 */

import { z } from 'zod/v4';
import type { StateStore } from '#internal/state-store';
import type { Memory } from '#internal/memory/types';
import type { PromptSegment } from '#internal/types';
import { requireToolMetadata } from '#internal/tool-catalog';

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
  memory: Memory;
  segments: PromptSegment[];
  /**
   * Turn-bounded 模式（方案 B）：signal_input_needed 调用此回调记 pending signal，
   * execute 立即返回 success:true；LLM 的 stopWhen 在下一 step 之前拦截 → generate()
   * 返回；外层 coreLoop 读 pendingSignal 更新 UI 并等玩家输入。
   *
   * 设计见 .claude/plans/turn-bounded-generate.md。
   *
   * 如果未提供此回调，signal_input_needed 会回退到报错（兼容过渡期；以前的挂起
   * 模式已被方案 B 取代）。
   */
  recordPendingSignal?: (options: SignalInputOptions) => void | Promise<void>;
  onSetMood?: (mood: string) => void;
  /**
   * `end_scenario` 工具调用时通知 game-session。
   * 调用后 game-session 会在本轮 generate 结束后不再进入下一轮 receive。
   * reason 是 LLM 可选传入的结束原因，用于持久化到 DB。
   */
  onScenarioEnd?: (reason?: string) => void;
  /**
   * M3: VN 场景工具回调
   * change_scene / change_sprite / clear_stage 都经由这个回调通知 game-session。
   * game-session 负责维护 currentScene state + 向前端 emitter 推送 scene-change 事件。
   */
  onSceneChange?: (patch: ScenePatch) => void;
}

/**
 * Scene 变化的 patch。不同工具产生不同形态：
 *   change_scene → { kind: 'full', background?, sprites?, transition? }
 *   change_sprite → { kind: 'single-sprite', sprite: { id, emotion, position? } }
 *   clear_stage → { kind: 'clear' }
 */
export type ScenePatch =
  | {
      kind: 'full';
      background?: string;
      sprites?: Array<{ id: string; emotion: string; position?: 'left' | 'center' | 'right' }>;
      transition?: 'fade' | 'cut' | 'dissolve';
    }
  | {
      kind: 'single-sprite';
      sprite: { id: string; emotion: string; position?: 'left' | 'center' | 'right' };
    }
  | { kind: 'clear' };

// ============================================================================
// Tool Definitions Factory
// ============================================================================

/**
 * 内部辅助：从 tool-catalog 拿 description/required，供 ToolHandler 使用。
 * 把元数据字段和运行时字段（parameters + execute）拼成完整 handler。
 */
function handler(
  name: string,
  parameters: z.ZodType,
  execute: (args: unknown) => unknown | Promise<unknown>,
): ToolHandler {
  const meta = requireToolMetadata(name);
  return {
    description: meta.description,
    parameters,
    execute,
    required: meta.required,
  };
}

export function createTools(ctx: ToolExecutorContext): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};

  // --- 必选工具 ---

  tools['update_state'] = handler(
    'update_state',
    z.object({
      updates_json: z.string()
        .describe('JSON string of key-value pairs to update, e.g. {"stage": 2, "turn_count_in_stage": 0}'),
    }),
    (args) => {
      const { updates_json } = args as { updates_json: string };
      try {
        const patch = JSON.parse(updates_json) as Record<string, unknown>;
        ctx.stateStore.update(patch, 'llm');
        return { success: true, updated: Object.keys(patch) };
      } catch {
        return { success: false, error: 'Invalid JSON' };
      }
    },
  );

  // signal_input_needed 是 turn-boundary 工具（方案 B）：execute 只记录 pending
  // signal，立即返回 success:true；LLM 的 stopWhen: hasToolCall('signal_input_needed')
  // 会在下一 step 发起之前拦截 → generate() 干净返回。外层 coreLoop 读 pendingSignal
  // 更新 UI（展选项 / 提示）并等玩家输入。
  //
  // 详见 .claude/plans/turn-bounded-generate.md
  tools['signal_input_needed'] = handler(
    'signal_input_needed',
    z.object({
      prompt_hint: z.string()
        .describe('Hint text to display to the player, e.g. "你想做什么？"'),
      choices: z.array(z.string())
        .describe('List of 2-4 suggested choices for the player, e.g. ["探索洞穴","返回村庄","休息一下"]. REQUIRED.'),
    }),
    async (args) => {
      const { prompt_hint, choices } = args as { prompt_hint: string; choices: string[] };
      if (!ctx.recordPendingSignal) {
        // 兼容过渡期：未接入 turn-bounded 的调用方
        return { success: false, error: 'No signal handler registered' };
      }
      await ctx.recordPendingSignal({ hint: prompt_hint, choices });
      // 返回简单的 success —— 玩家实际选择通过下一轮 generate() 的 user message
      // 体现，不放进 tool_result。see plan doc.
      return { success: true };
    },
  );

  // end_scenario 是"通知型"工具：execute 是同步的，仅记下 LLM 意图，
  // 把"结束整个 session"的实际动作交给 game-session 在本轮 generate()
  // 结束后统一处理。LLM 会拿到 success=true 的 tool result，可以继续
  // 在同一个 step 里写一些收尾文字再 stop。
  tools['end_scenario'] = handler(
    'end_scenario',
    z.object({
      reason: z.string().optional()
        .describe('Optional short explanation of why the scenario is ending (e.g. "reached the published ending" or "all plotlines resolved").'),
    }),
    (args) => {
      const { reason } = args as { reason?: string };
      if (!ctx.onScenarioEnd) {
        return { success: false, error: 'No scenario-end handler registered' };
      }
      ctx.onScenarioEnd(reason);
      return { success: true, reason: reason ?? null };
    },
  );

  // --- 可选工具 ---

  tools['read_state'] = handler(
    'read_state',
    z.object({
      keys: z.array(z.string()).optional()
        .describe('Specific state keys to read. Omit for full state.'),
    }),
    (args) => {
      const { keys } = args as { keys?: string[] };
      if (keys && keys.length > 0) {
        return ctx.stateStore.getKeys(keys);
      }
      return ctx.stateStore.getAll();
    },
  );

  tools['query_changelog'] = handler(
    'query_changelog',
    z.object({
      key: z.string().optional().describe('Filter by variable name'),
      turn_min: z.number().optional().describe('Minimum turn number'),
      turn_max: z.number().optional().describe('Maximum turn number'),
    }),
    (args) => {
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
  );

  tools['pin_memory'] = handler(
    'pin_memory',
    z.object({
      content: z.string().describe('The important content to remember'),
      tags: z.array(z.string()).optional().describe('Optional tags for categorization'),
    }),
    async (args) => {
      const { content, tags } = args as { content: string; tags?: string[] };
      const entry = await ctx.memory.pin(content, tags);
      return { success: true, id: entry.id };
    },
  );

  tools['query_memory'] = handler(
    'query_memory',
    z.object({
      query: z.string().describe('Search keywords'),
    }),
    async (args) => {
      const { query } = args as { query: string };
      // Memory.retrieve 返回 { summary, entries } —— summary 本就会出现在
      // _engine_memory section，这里 LLM 主动查时把相关 entries 返回给它看。
      const retrieval = await ctx.memory.retrieve(query);
      return {
        summary: retrieval.summary.slice(0, 1000),
        entries: (retrieval.entries ?? []).slice(0, 5).map((e) => ({
          turn: e.turn,
          role: e.role,
          content: e.content.slice(0, 500),
          pinned: e.pinned,
        })),
      };
    },
  );

  tools['inject_context'] = handler(
    'inject_context',
    z.object({
      doc_id: z.string().describe('The document/segment ID to inject'),
    }),
    (args) => {
      const { doc_id } = args as { doc_id: string };
      const segment = ctx.segments.find((s) => s.id === doc_id);
      if (!segment) {
        return { success: false, error: `Document "${doc_id}" not found` };
      }
      return { success: true, content: segment.content };
    },
  );

  tools['list_context'] = handler(
    'list_context',
    z.object({}),
    () => {
      return ctx.segments
        .filter((s) => s.role === 'context')
        .map((s) => ({ id: s.id, label: s.label, tokens: s.tokenCount }));
    },
  );

  tools['set_mood'] = handler(
    'set_mood',
    z.object({
      mood: z.string().describe('Mood tag like "tense", "melancholy", "peaceful"'),
    }),
    (args) => {
      const { mood } = args as { mood: string };
      ctx.onSetMood?.(mood);
      return { success: true, mood };
    },
  );

  // --- VN 场景工具（M3 新增） ---
  tools['change_scene'] = handler(
    'change_scene',
    z.object({
      background: z.string().optional().describe('Background asset id (snake_case, e.g. "classroom_evening"). Omit to keep current.'),
      sprites: z
        .array(
          z.object({
            id: z.string().describe('Character id (snake_case)'),
            emotion: z.string().describe('Emotion/pose id (snake_case)'),
            position: z.enum(['left', 'center', 'right']).optional(),
          }),
        )
        .optional()
        .describe('Full sprite stack replacing current. Empty array = clear sprites.'),
      transition: z.enum(['fade', 'cut', 'dissolve']).optional().describe('Visual transition style, default "fade"'),
    }),
    (args) => {
      const { background, sprites, transition } = args as {
        background?: string;
        sprites?: Array<{ id: string; emotion: string; position?: 'left' | 'center' | 'right' }>;
        transition?: 'fade' | 'cut' | 'dissolve';
      };
      ctx.onSceneChange?.({ kind: 'full', background, sprites, transition });
      return { success: true };
    },
  );

  tools['change_sprite'] = handler(
    'change_sprite',
    z.object({
      character: z.string().describe('Character id (snake_case)'),
      emotion: z.string().describe('New emotion/pose id'),
      position: z.enum(['left', 'center', 'right']).optional(),
    }),
    (args) => {
      const { character, emotion, position } = args as {
        character: string;
        emotion: string;
        position?: 'left' | 'center' | 'right';
      };
      ctx.onSceneChange?.({
        kind: 'single-sprite',
        sprite: { id: character, emotion, position },
      });
      return { success: true };
    },
  );

  tools['clear_stage'] = handler(
    'clear_stage',
    z.object({}),
    () => {
      ctx.onSceneChange?.({ kind: 'clear' });
      return { success: true };
    },
  );

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
