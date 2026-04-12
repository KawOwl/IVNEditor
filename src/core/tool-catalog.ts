/**
 * Tool Catalog — 引擎所有工具的元数据单一真源
 *
 * 这里维护全系统共享的工具名称、描述、分类（必选/可选）、UI 标签。
 * 运行时执行逻辑（execute 函数 + 参数 Schema）在 tool-executor.ts 里，
 * 但描述、required、UI 文案都从这里读，避免多处硬编码工具清单导致漂移。
 *
 * 使用场景：
 * - tool-executor.ts: createTools() 内部读取 description 和 required
 * - context-assembler / rewritePrompt: 给不走 tool-use 接口的 LLM 任务
 *   动态生成工具清单 markdown
 * - ScriptInfoPanel: "启用工具" UI 清单
 *
 * 历史：v2.7 之前还喂给 completion-sources.ts 做 `{{tool:xxx}}` DSL 补全，
 * 但那个 DSL 本身下线了（运行时不 substitute，LLM 只看到字面标记，小模型
 * 会泄漏）。现在编剧直接写工具的裸名。
 *
 * 修改规则：
 * - 新增工具：先在本文件加 entry，再去 tool-executor 加 execute/parameters
 * - 修改描述：只改这里的 description，tool-executor 自动同步
 * - 修改 UI 文案：只改这里的 uiLabel/uiDescription
 */

export interface ToolMetadata {
  /** 工具名（LLM tool-use 直接用这个字面量识别） */
  name: string;
  /** 英文描述，给 LLM 看（作为 tool schema description 或 prompt 内工具清单） */
  description: string;
  /** 中文短标签，给编剧看（启用工具 checkbox） */
  uiLabel: string;
  /** 中文简介，给编剧看（补全候选、启用工具说明） */
  uiDescription: string;
  /** true = 必选（引擎默认注入，不经过启用开关），false = 可选 */
  required: boolean;
}

// ============================================================================
// Catalog
// ============================================================================

export const TOOL_CATALOG: readonly ToolMetadata[] = [
  // --- 必选工具 ---
  {
    name: 'update_state',
    description: 'Update game state variables. Pass a JSON string of key-value pairs to update.',
    uiLabel: '更新状态',
    uiDescription: '更新游戏状态变量（好感度、阶段、物品等）',
    required: true,
  },
  {
    name: 'signal_input_needed',
    description: 'Signal that the narrative has reached a point where player input is needed. You MUST provide choices as a list of 2-4 options for the player to choose from. The player can also type freely.',
    uiLabel: '请求玩家输入',
    uiDescription: '叙事到达分支点时，提供 2-4 个选项按钮（玩家仍可自由输入）',
    required: true,
  },
  {
    name: 'end_scenario',
    description: 'End the current scenario. Call this only when the story has definitively concluded — either reaching an ending explicitly defined in the script prompt, or the natural terminal point of all planned plotlines. After calling, the session transitions to a "finished" state and no further player input will be accepted. DO NOT call this for temporary pauses, cliffhangers, or minor scene breaks — use signal_input_needed for those. Optionally provide a `reason` string summarizing why the scenario is ending.',
    uiLabel: '结束剧情',
    uiDescription: '剧情走完（prompt 里明确的结局或所有剧情线自然收束）时调用，之后不再接受玩家输入',
    required: true,
  },

  // --- 可选工具 ---
  {
    name: 'read_state',
    description: 'Read current game state. Pass specific keys to read only those fields, or omit for all.',
    uiLabel: '读取状态',
    uiDescription: '查看当前状态变量（GM 需要确认非 prompt 内的状态时）',
    required: false,
  },
  {
    name: 'query_changelog',
    description: 'Query the state change history. Filter by variable name, turn range, or time range.',
    uiLabel: '查询变更日志',
    uiDescription: '查询状态变更历史（GM 回顾变量变化时）',
    required: false,
  },
  {
    name: 'pin_memory',
    description: 'Mark important content as a pinned memory that will be preserved during compression.',
    uiLabel: '钉住记忆',
    uiDescription: '标记重要记忆，压缩时保留（需要长期记住的关键信息）',
    required: false,
  },
  {
    name: 'query_memory',
    description: 'Search through past memories using keywords. Use this to verify details before referencing them.',
    uiLabel: '查询记忆',
    uiDescription: '按关键词搜索历史记忆（引用过去事件前核实）',
    required: false,
  },
  {
    name: 'inject_context',
    description: 'Load a world knowledge document into the current context. One-time injection for this turn only.',
    uiLabel: '注入上下文',
    uiDescription: '临时注入世界观文档到当前轮次上下文',
    required: false,
  },
  {
    name: 'list_context',
    description: 'List all available world knowledge documents with their IDs and descriptions.',
    uiLabel: '列出上下文',
    uiDescription: '列出可注入的世界观文档清单（配合 inject_context 使用）',
    required: false,
  },
  {
    name: 'set_mood',
    description: 'Set the current scene mood/atmosphere for UI rendering.',
    uiLabel: '设置情绪',
    uiDescription: '设置当前场景氛围标签（影响 UI 视觉风格）',
    required: false,
  },
  {
    name: 'show_image',
    description: 'Display an image or CG in the UI.',
    uiLabel: '显示图片',
    uiDescription: '在玩家界面展示图片/CG',
    required: false,
  },
];

// ============================================================================
// Index + Query
// ============================================================================

const CATALOG_INDEX = new Map<string, ToolMetadata>(
  TOOL_CATALOG.map((t) => [t.name, t]),
);

/**
 * 按名字查工具元数据。未注册的返回 undefined。
 */
export function getToolMetadata(name: string): ToolMetadata | undefined {
  return CATALOG_INDEX.get(name);
}

/**
 * 断言版本 —— 查不到直接抛错（用于 tool-executor 等强耦合场景，
 * 定义漏写时宁可启动时崩也别运行到中间才崩）。
 */
export function requireToolMetadata(name: string): ToolMetadata {
  const meta = CATALOG_INDEX.get(name);
  if (!meta) {
    throw new Error(`[tool-catalog] Tool "${name}" not found in catalog`);
  }
  return meta;
}

export interface ListToolsFilter {
  /** 只返回必选 / 只返回可选；不传返回全部 */
  required?: boolean;
  /** 白名单：只返回 names 列表中的工具 */
  names?: readonly string[];
}

/**
 * 过滤工具元数据清单。
 *
 * @example
 * listTools()                        // 全部
 * listTools({ required: false })     // 只要可选
 * listTools({ names: enabledTools }) // 当前剧本启用的
 */
export function listTools(filter?: ListToolsFilter): ToolMetadata[] {
  return TOOL_CATALOG.filter((t) => {
    if (filter?.required !== undefined && t.required !== filter.required) return false;
    if (filter?.names && !filter.names.includes(t.name)) return false;
    return true;
  });
}

/**
 * 生成 markdown 格式的工具清单，供不走 AI SDK tool-use 接口的任务嵌入 prompt。
 *
 * 对于走 tool-use 接口的运行时 GM，不需要调用此函数 —— AI SDK 会自动把工具
 * 定义注入成 schema 发给 LLM。此函数是为"纯文本生成任务"（如编辑器 AI 改写）
 * 准备的：那些任务的 LLM 看不到 tool 接口，只能从 prompt 文本里学工具清单。
 */
export function buildToolCatalogMd(filter?: ListToolsFilter): string {
  const tools = listTools(filter);
  const required = tools.filter((t) => t.required);
  const optional = tools.filter((t) => !t.required);

  const parts: string[] = [];

  if (required.length > 0) {
    parts.push('### 必选工具（引擎默认注入，始终可用）');
    for (const t of required) {
      parts.push(`- \`${t.name}\` — ${t.description}`);
    }
  }

  if (optional.length > 0) {
    if (parts.length > 0) parts.push('');
    parts.push('### 可选工具（按剧本启用）');
    for (const t of optional) {
      parts.push(`- \`${t.name}\` — ${t.description}`);
    }
  }

  return parts.join('\n');
}
