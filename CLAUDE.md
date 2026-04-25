# CLAUDE.md — Agent 工作流规范

本文件定义 Claude 在本项目中的工作流程。每次会话开始时必须阅读本文件。

---

## 一、核心原则

以下原则综合自 Anthropic 和 OpenAI 的 Harness Engineering 实践：

1. **会话间无记忆，靠文件传递上下文**：每次新会话/context reset 后，通过读取项目文件恢复完整认知，而非依赖对话记忆。
2. **增量推进，一次一个 Step**：每次只聚焦 feature_list.json 中的一个 Step，完成并验证后再开始下一个。收到跨多个 Step 的大指令时，仍逐个 Step 执行开发循环，不批量实现。
3. **结构化交接**：每次会话结束前，将进展、决策、遗留问题写入追踪文件，确保下次会话无缝衔接。
4. **约束优于自由**：通过类型定义、目录结构、lint 规则限制实现空间，提高一致性。
5. **用人类工程实践要求自己**：提交纪律（小而频繁的 commit）、文档更新、验证后再推进。

---

## 二、项目记忆系统

项目通过以下文件维护跨会话的"记忆"：

### `feature_list.json` — 功能清单（JSON，不易被意外改写）

每个 feature 是一个离散的、可验证的单元：

```json
{
  "id": "2.1",
  "title": "文档上传 + 分类",
  "description": "上传编剧文档，自动分类为 GM prompt / 世界观 / 角色设定等",
  "status": "pending",
  "type": "ui",
  "ref": "v2.0.md#二、Authoring Layer",
  "verify": "上传 .md 文件后，UI 正确显示分类结果；分类逻辑对 MODULE_7 测试文档输出正确类别"
}
```

字段说明：
- `status`: `"done"` / `"in-progress"` / `"pending"`
- `type`: `"logic"` / `"ui"` / `"e2e"` — 决定验证方式的底线
- `ref`: 指向 v2.0.md 中的详细设计章节（实现细节只在 v2.0.md 维护，不在此重复）
- `verify`: 该 feature 特有的验收条件（通用底线 + 此条件都满足才能标记 done）

### `PROGRESS.md` — 当前任务 + 决策记录

不再包含功能清单（已移至 feature_list.json），只保留叙述性内容：

```markdown
# 项目进度

## 当前状态
[一句话描述当前进展到哪里]

## 当前任务
**[任务标题]**
- 类型：实现 / 回归验证 / bug fix / 调研 / 重构 / ...
- 来源：Step X.X / 用户临时指派 / 自查发现 / ...
- 目标：[具体要做什么]
- 进展：[已完成的部分、下一步]

## 关键决策记录
| 日期 | 决策 | 原因 | 影响 |
|------|------|------|------|

## 遗留问题 / 待讨论
- [ ] 问题描述...
```

### `v2.0.md` — 架构设计文档

完整的架构设计，包含类型定义、模块职责、工具清单、所有设计决策。是实现的"规格说明"。

### `2.0架构设计决策讨论.md` — 设计讨论记录

完整的对话记录，记录每个设计决策的讨论过程和最终结论。

**重要：此文件及所有设计讨论/决策类文件必须记录原文，禁止压缩或摘要。** 备份对话时，User 消息和 Assistant 消息都必须是逐字原文，不得用总结替代。原因：压缩会丢失推理细节和决策上下文，导致后续会话无法准确还原设计意图。

---

## 三、每次会话的工作流

### 会话启动仪式

每次新会话（包括 context reset 后），按以下顺序恢复上下文：

1. **读 CLAUDE.md**（本文件）— 了解工作流规范
2. **读 PROGRESS.md** — 了解当前任务、关键决策
3. **读 feature_list.json** — 了解所有 feature 的状态，定位下一个 pending
4. **读 git log（最近 10 条）** — 了解最近的代码变更
5. **读 v2.0.md 的相关章节**（按当前 feature 的 ref 字段定位）
6. **确认当前任务** — 从 PROGRESS.md 中的"当前任务"继续，或从 feature_list.json 选取下一个 pending

### 开发循环（每个 feature）

```
1. 确定下一个 Step（来源：feature_list.json 中最高优先级的 pending / 用户临时指派 / 自查发现）
2. 更新：feature_list.json 该 Step 状态设为 "in-progress"，PROGRESS.md "当前任务"写明类型、来源、目标
3. 读取 v2.0.md 中该 feature 的 ref 章节，获取实现细节
4. 实现功能（小步提交，每个有意义的进展都 commit）
5. 验证功能（两层验证，都通过才能标记 done）：
   a. 通用底线（按 feature 的 type 字段）：
      - logic：类型检查通过（`tsc --noEmit`）+ 单元测试
      - ui：类型检查 + 启动 dev server 在浏览器中确认渲染正常
      - e2e：实际走通完整流程（含浏览器交互）
   b. 专属验收条件（feature 的 verify 字段）
6. 更新：feature_list.json 该 Step 状态设为 "done"，PROGRESS.md 记录关键决策
7. 如果有设计调整，同步更新 v2.0.md
8. 选取下一个 Step，重复
```

### 关键决策记录规则

以下情况必须记录到 PROGRESS.md 的"关键决策记录"：

- 偏离了 v2.0.md 中的原始设计
- 技术选型变更（换库、换方案）
- 发现了设计文档中未预见的问题
- 用户明确要求的设计调整

### 会话结束 / Context 即将耗尽时

1. 将当前进展写入 PROGRESS.md
2. 确保所有有意义的代码已 commit
3. 在 PROGRESS.md 的"当前任务"中详细记录：
   - 已完成的部分
   - 下一步要做什么
   - 任何需要注意的问题

---

## 三·五、Preview 启动顺序（避免 fetch race）

通过 Claude Preview MCP 起 dev 环境时**必须先 server 后 dev**，否则前端会在 backend 还没 listen 时跑 `ensureSessionId` → `fetch /api/auth/init` 失败 → React 19 + StrictMode 把 effect 错误包装成误导性的 "Invalid hook call. ... more than one copy of React"（实际并不是双 React，是 effect crash 把 hooks dispatcher 污染了）。

**正确顺序**：

1. `preview_start server`（或 `bun run --cwd apps/server src/index.mts`）
2. **轮询 health 接口**直到返回 200：
   ```
   until curl -sf http://localhost:3001/health > /dev/null; do sleep 0.3; done
   ```
   `GET /health` 返回 `{"ok":true,"timestamp":...}`，不需要 auth。**不要靠 stdout 文本匹配判断启动完成**——日志格式会变。
3. `preview_start dev`

`launch.json` 的 `dependsOn` 字段 Claude Preview MCP 不支持（已实测，被静默忽略），所以这个顺序只能靠纪律保证。

---

## 四、提交纪律

- **小而频繁**：每完成一个有意义的步骤就提交
- **提交信息格式**：`类型: 简短描述`（feat / fix / refactor / docs / chore）
- **不要积攒大量改动一次性提交**
- **每次 commit 前确认**：类型检查通过、不包含敏感信息

---

## 五、目录结构约束

```
src/
  core/           # 引擎核心（纯逻辑，不依赖 React）
  ui/             # React UI 组件
  store/          # Zustand stores（连接 core 和 ui）
  storage/        # IndexedDB 持久化
  fixtures/       # 测试用的手写 IR 数据
```

依赖分层规则：
```
types（纯类型）→ core（纯逻辑）→ store（状态管理）→ ui（React）
                                  ↘ storage（持久化）
```

- `core/` 不得 import React 或 Zustand
- `ui/` 通过 `store/` 间接访问 `core/`
- `storage/` 只被 `store/` 调用

---

## 六、技术栈

- React 19 + TypeScript 5.7 + Vite 6
- Zustand 5（状态管理）
- Zod 3（运行时验证）
- Vercel AI SDK（LLM 调用）
- shadcn/ui（UI 组件，底层 Radix + Tailwind）
- idb（IndexedDB 封装）
- ReactFlow（Phase 3，流程图编辑器）
