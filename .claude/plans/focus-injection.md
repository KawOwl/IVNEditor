# Focus Injection —— 按当前场景/人物/阶段动态聚焦 Prompt

> Status: **Draft → 开工**
> Owner: @kawowl
> 创建日期：2026-04-22

---

## 动机

当前引擎把编剧所有 segment **全量注入** system prompt（按 priority 排序 + injectionRule 硬条件过滤）。这导致：

1. **in-context style drift**（见 IVNEditor 评审 Part 1 Round 5）：LLM 看到大量历史原文 + 无差别世界观设定，style prompt 被稀释
2. **多角色/多场景剧本信号弱**：咖啡馆只有 1 个 segment 问题不明显，但 MODULE_7 级别（15000 字 GM + 多角色 + 多场景）里 LLM 不知道此刻该聚焦哪块
3. **Memory retrieve query 单薄**：`buildRetrievalQuery` 现在只传最近玩家输入，没有利用"当前场景/阶段"这类结构化信号

本功能在**保留全量注入**的基础上，加一层**焦点指示层**：

- 从 state_vars 读 `current_scene`（MVP 一维，后续扩 characters/stage）
- 新 section `_engine_scene_context` 告诉 LLM "现在 scene=cafe_interior，最相关的 segment 是 X/Y/Z"
- Memory retrieve query 也拼上 scene，让记忆检索更聚焦

---

## 设计决策（Q1-Q5 拍板记录）

| 问题 | 决定 | 依据 |
|-----|------|------|
| **Q1**：scene/chars/stage 怎么得到？ | **A. 读 state_vars** | 跑了"update_state 漏调率"自测，12/12 = 100% 遵守率（咖啡馆 + 明确 prompt 规则）。零成本、零延迟。 |
| **Q2**：segment 标签从哪来？ | **a. 编剧手打**（MVP） | 赶时间，先跑通；后续如果值得再做 Architect 自动识别 + frontmatter 半结构化 |
| **Q3**：注入位置？ | 新 section `_engine_scene_context`；`_engine_memory` 保留原样 | 两个源职责不同，分开放 |
| **Q4**：替换还是补充？ | **A1 + B1**：老 segment 全量注入（加 label header）+ 新 section 放 focus 元信号 + 相关 segment ID 列表 | 最保守、零破坏；后续可渐进升级到 B2（按 ID 过滤注入）无需返工 |
| **Q5**：scope 切分 | MVP 只做 scene 维度 + memory 用新 query；v2 扩 characters + stage | 降低一次上线面 |

---

## MVP 范围（一次性上）

### 功能 1：Focus Injection（scene 维度）

- `PromptSegment.focusTags?: { scene?: string; chars?: string[]; stage?: string }` 字段
  - MVP 只读 `scene`；`chars` / `stage` 字段先预留不消费
- 运行时从 `stateVars.current_scene` 读当前 scene
- 对所有 segment 打分（MVP：scene tag 匹配 = +3，不匹配或无 tag = 0）
- 新 virtual section `_engine_scene_context`：
  ```
  ---
  [Current Focus]
  scene: cafe_interior

  Most relevant segments:
   - char_sakuya
   - scene_cafe_interior
   - stage_chat
  ---
  ```
- 原有 segment 注入**加 label header** 作为 ID 锚点：
  ```
  --- [char_sakuya] ---
  <segment content>
  ```

### 功能 2：Memory retrieve query 升级

- `game-session.buildRetrievalQuery()` 从"最近玩家输入"升级为："`${current_scene}. ${lastPlayerInput}`"
- Memory interface 不变（还是 `retrieve(query: string)`），只是 query 更结构化
- Legacy / LLMSummarizer 下 query 对 summary 内容影响不大；Mem0 下 semantic search 会明显受益

### 非目标（v2/v3 再做）

- characters 维度
- stage 维度
- Architect 自动打 focusTags
- frontmatter 支持
- segment 过滤注入（B2/B3）
- 编辑器的 focusTags 多字段 UI（MVP 只 scene 一个输入）

---

## 渐进升级路径（A1 + B1 → B2）

当前 A1 + B1 做的所有组件都是 B 系列（按标签过滤注入）的必需基础：

| 组件 | A1+B1 | B2 升级新增 |
|-----|-------|-----------|
| `focusTags` 字段 | ✅ | — |
| `computeFocus(state)` | ✅ | — |
| `scoreSegment(seg, focus)` | ✅ 用于选 top N 显 ID | 改为用于过滤注入 |
| label header 注入 | ✅ | 保持 |
| `_engine_scene_context` section | ✅ 放 ID 列表 | 内容可换成 "本次已过滤掉的 segment 列表（供 debug）" |

**B2 升级的本质改动：在 `assembleContext` 的 active segments filter 里加一条**：

```ts
const focusFiltered = activeSegments.filter((seg) => {
  if (!seg.focusTags) return true;            // 无标签 → 保留
  return scoreSegment(seg, currentFocus) > 0; // 有标签 → 必须匹配
});
```

约 10 行代码。

**升级触发条件**（A1+B1 上线后观察）：
1. Prompt token 超预算（MODULE_7 级大剧本）
2. 观察 trace：LLM 是否真的按 focus ID 聚焦？如果 ID marker 信号太弱，B2 靠硬过滤才行
3. 为配合 B2，可引入 `focusTags: { scene: 'any' }` 表示"全局必看"，防止 B2 过滤误删

---

## 实施清单

### 1. 代码改动

#### 1.1 types / schema

**`src/core/types.ts`**：
```ts
export interface FocusTags {
  scene?: string;
  chars?: string[];   // v2 用
  stage?: string;     // v2 用
}
export interface PromptSegment {
  // ...existing fields
  focusTags?: FocusTags;
}
export interface FocusState {
  scene?: string;
  characters?: string[];
  stage?: string;
}
```

**`src/core/schemas.ts`**：`promptSegmentSchema` 加 `focusTags` 可选字段。

#### 1.2 新建 `src/core/focus.ts`

```ts
import type { PromptSegment, FocusState } from './types';

/**
 * 从 state_vars 读出当前 focus。
 * MVP 只读 current_scene；v2 扩展读 active_characters 和 current_phase。
 * 剧本 state 里没相关字段时返回空对象 —— adapter 会 degrade 为无 focus。
 */
export function computeFocus(stateVars: Record<string, unknown>): FocusState {
  return {
    scene: typeof stateVars.current_scene === 'string'
      ? stateVars.current_scene
      : undefined,
  };
}

/**
 * segment 和 focus 的匹配分数。
 * MVP 只看 scene 维度。分数 0 = 不匹配。
 */
export function scoreSegment(seg: PromptSegment, focus: FocusState): number {
  if (!seg.focusTags) return 0;          // 无标签 = 不参与排序
  let score = 0;
  if (seg.focusTags.scene && focus.scene === seg.focusTags.scene) score += 3;
  return score;
}

/** 返回按分数降序、score > 0 的 segment 列表 */
export function rankSegments(
  segments: PromptSegment[],
  focus: FocusState,
  topN = 5,
): PromptSegment[] {
  return segments
    .map((seg) => ({ seg, score: scoreSegment(seg, focus) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map((x) => x.seg);
}
```

#### 1.3 context-assembler 改动

**`src/core/context-assembler.ts`**：

- 加 `VIRTUAL_IDS.SCENE_CONTEXT = '_engine_scene_context'`
- `AssembleOptions` 加 `focus?: FocusState`（由 game-session 传入）
- segment 注入时用 label header 包裹（核心 diff）：
  ```ts
  // 原：直接 sectionContent.set(seg.id, content)
  // 新：加 label 包裹
  const label = seg.label || seg.id;
  const wrapped = `--- [${label}] ---\n${content}`;
  sectionContent.set(seg.id, wrapped);
  ```
  （⚠ 兼容：label 和 id 的显示值用 segment 已有的 label 字段优先，空时 fallback 到 id）
- 构建 `_engine_scene_context` section（focus + top N ranked labels）：
  ```ts
  if (!disabledSet.has(VIRTUAL_IDS.SCENE_CONTEXT) && focus?.scene) {
    const top = rankSegments(activeSegments, focus, 5);
    if (top.length > 0) {
      const lines = [
        '[Current Focus]',
        `scene: ${focus.scene}`,
        '',
        'Most relevant segments:',
        ...top.map((s) => ` - ${s.label || s.id}`),
      ];
      const content = `---\n${lines.join('\n')}\n---`;
      sectionContent.set(VIRTUAL_IDS.SCENE_CONTEXT, content);
      sectionTokens.set(VIRTUAL_IDS.SCENE_CONTEXT, estimateTokens(content));
    }
  }
  ```
- 默认 assembly order 里 `_engine_scene_context` 放 `_engine_state` 之后、`_engine_memory` 之前（焦点放在前面）

#### 1.4 game-session 改动

- `assembleContext` 调用加 `focus: computeFocus(stateStore.getAll())`
- `buildRetrievalQuery` 升级：
  ```ts
  private async buildRetrievalQuery(): Promise<string> {
    const focus = computeFocus(this.stateStore.getAll());
    const parts = [];
    if (focus.scene) parts.push(focus.scene);
    if (this.lastPlayerInput) parts.push(this.lastPlayerInput);
    return parts.join('. ');
  }
  ```

#### 1.5 编辑器 UI

**`src/ui/editor/EditorPage.tsx`** Document 类型加字段：
```ts
interface Document {
  // ...existing
  focusScene: string;   // empty = no tag
}
```

编辑器底栏（segment 列表每行，大约 L1620 附近 `Condition:` 那个 label）旁边加 `Scene:` 输入：

```tsx
{/* Focus Scene (MVP 一维) */}
<label className="flex items-center gap-1 text-zinc-500 min-w-0">
  Scene:
  <input
    type="text"
    value={doc.focusScene}
    onChange={(e) => onMetaChange('focusScene', e.target.value)}
    placeholder="空 = 全局"
    className="w-32 bg-zinc-900 border border-zinc-700 rounded px-1.5 py-0.5 text-zinc-300 text-xs font-mono placeholder:text-zinc-600 focus:outline-none"
  />
</label>
```

EditorPage 保存剧本时：
```ts
focusTags: doc.focusScene ? { scene: doc.focusScene } : undefined,
```

加载剧本时反向映射：
```ts
focusScene: seg.focusTags?.scene ?? '',
```

#### 1.6 PromptPreviewPanel

`src/ui/editor/PromptPreviewPanel.tsx`：把 `_engine_scene_context` 加进虚拟 section 列表，作为 `dynamic` 占位 —— 运行时动态填充提示。

### 2. 咖啡馆剧本升级

通过 SQL update script_versions.manifest：

1. state schema 加 `current_scene`：
   ```ts
   { name: 'current_scene', type: 'string', initial: 'cafe_interior',
     description: '当前场景 id：cafe_interior / cafe_window' }
   ```
2. GM prompt 加规则：
   > **调 `change_scene` 时同步调 `update_state({current_scene: ...})`**，保持场景变量和视觉一致。值用 `cafe_interior` / `cafe_window`。
3. 把咖啡馆的 1 个大 segment 拆成 2-3 个带标签：
   - `char_sakuya`: 角色设定 + 说话风格，focusTags = undefined（全局）
   - `scene_cafe_interior`: cafe_interior 背景描述 + 氛围，focusTags = { scene: 'cafe_interior' }
   - `scene_cafe_window`: cafe_window（窗外街景）描述，focusTags = { scene: 'cafe_window' }

这样同一 playthrough 里，window/interior 场景切换时 `_engine_scene_context` 的 top ID 列表会变。

### 3. 清理（上次测试残留）

1. **删** `src/core/tool-executor.ts` 里的 fs.appendFileSync debug hook
2. **恢复** 咖啡馆 manifest `enabledTools` 里的 `end_scenario`（上次为强跑 30 轮禁的）
3. **保留** 上次加的 `current_phase` state 字段 + 规则 —— v2 扩展 stage 维度时复用

### 4. 验证

#### 4.1 类型检查 + 单测
- `bun tsc --noEmit` 两端全绿
- `bun --env-file=.env.test test` → 95 pass 不 break

#### 4.2 E2E smoke
- 启动咖啡馆，玩 2-3 轮
- 观察 Langfuse trace（或直接 server DB）里的 system prompt：
  - [ ] 每个 segment 前有 `--- [label] ---` header
  - [ ] `_engine_scene_context` section 存在且 `scene: cafe_interior`
  - [ ] `Most relevant segments` 列出 `char_sakuya` 和 `scene_cafe_interior`（不含 `scene_cafe_window` —— 它不匹配）
  - [ ] 当 LLM 调 `change_scene` 切到 cafe_window + `update_state({current_scene: 'cafe_window'})` 后，下一轮 _engine_scene_context 里 scene 更新、ranked segments 变

#### 4.3 buildRetrievalQuery 升级
- 查 log / debug: `memory.retrieve(query)` 的 query 里拼了 scene
- 对 legacy adapter 影响很小；对未来 mem0 使用时 retrieve 质量应有明显改善

---

## 风险 / 兜底

1. **编剧不填 focusTags**：
   - `_engine_scene_context` 会因为 top=0 而不生成（section 为空跳过）
   - 效果等同于没做这个功能，**零破坏**

2. **state.current_scene 和 segment.focusTags.scene 名字对不上**：
   - rankSegments 返回空，同上降级

3. **label 撞名**：
   - segment.label 可能多个重名。MVP 不处理，LLM 能容忍一定重复；B2 升级时要求 label 唯一

4. **B2 升级误删 segment**：留到 B2 阶段再处理，MVP 不涉及

---

## 时间估计

- **代码改动**：~4 小时（types 0.5h + focus.ts 0.5h + assembler 1h + game-session 0.5h + editor UI 0.5h + preview 0.5h + 咖啡馆升级 0.5h）
- **验证**：~1 小时 smoke
- **合计**：~5 小时

一次 commit 落地；细粒度 commit 按 "types/core → UI → 咖啡馆升级 → smoke" 拆 4 个也行。
