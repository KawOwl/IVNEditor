# M1：玩家侧 VN 渲染层 + M2：编辑器侧资产管理

## Context

M3（XML-lite 叙事协议 + 场景状态 + 视觉工具）已上线，后端吐出 `parsedSentences[]` + `currentScene`，但前端仍走老 chat 气泡（`NarrativeView.tsx` 消费 `entries[]`），M3 数据白产出。
M1 把玩家侧渲染换成 VN 全屏风格（背景/立绘/对话框三层），纯从 `parsedSentences` + `currentScene` 渲染。
M2 给编辑器补上 `characters` / `backgrounds` / `defaultScene` 的 UI（目前只能手写 JSON）。

## 锁定的设计决策

| 决策 | 选定 |
|---|---|
| 推进模型 | click-to-advance，一次一句；**只做 manual**（不做 auto/skip） |
| narration 渲染 | 和 dialogue **共用对话框**；speaker 区域留空/隐藏（不做全屏黑幕） |
| openingMessages | 前置合成为 **synthetic narration Sentence**（index 负数），走同一个管线 |
| 老 NarrativeView | 直接**下线**；EditorDebugPanel 加 "raw streaming" dev tab 补偿 |
| Backlog 回跳 | MVP **只读**，不能点历史 Sentence 跳回（改游标风险大） |
| 顺序 | **M1 先 → M2 后** |
| M1 范围外 | BGM / 音效 / 语音 / 存读档 / 章节过渡动画 / 立绘拖拽编辑 |
| 资产 URL 空值 | 显示占位（`[sakuya:smile]` 卡片 / 色块 + id），M4 填 URL 后自动替换 |

## M1：玩家侧 VN 渲染（10 步）

### Step 1.1 — VN 三层组件骨架（静态渲染）

**新增**
- `src/ui/play/vn/VNStage.tsx` — 整体容器，三层堆叠（背景/立绘/对话框）
- `src/ui/play/vn/SceneBackground.tsx` — 全屏背景层，读 `currentScene.background`
- `src/ui/play/vn/SpriteLayer.tsx` — 立绘层，按 `SpriteState.position`（left/center/right）摆放
- `src/ui/play/vn/DialogBox.tsx` — 底部对话框，narration 与 dialogue **共用**；speaker 可空

**不做**
- WS 接入、推进逻辑、动效、资产文件加载

**验收**
手动在 store 里写死 `currentScene` 和 `visibleSentenceIndex`，UI 能正确渲染三层；narration 无 speaker；dialogue 有 `pf.speaker` 显示。

---

### Step 1.2 — click-to-advance 推进模型 + 光标 state

**改**
- `src/stores/game-store.ts` 增字段：
  - `visibleSentenceIndex: number | null` —— 当前展示到的 Sentence 索引
  - （**不**加 playMode，只做 manual）
- 增 action：`advance()` / `setVisibleSentenceIndex(n)` / `resetPlayback()`

**VNStage 行为**
- 监听点击 / `Space` / `Enter` / `→` 触发 `advance()`
- 游标追上 `parsedSentences.length - 1` 时对话框显示"…"占位（等 LLM 产新句）
- LLM 产新句时游标**不自动前进**（manual-only），玩家需手动点

**验收**
Mock 一个 parsedSentences 数组（3 narration + 2 dialogue），能用键盘/鼠标一句句推进；推到末尾显示等待状态。

---

### Step 1.3 — openingMessages 前置为 synthetic narration

**删**
- `src/ui/play/PlayPanel.tsx` 开场逻辑里 `appendEntry(role:'system')` 两处（~line 104 和 240）

**新增**
- `game-store.ts` 增 action `seedOpeningSentences(messages: string[], scene: SceneState)`
  - 每条 msg 合成 `{ kind:'narration', text, sceneRef: scene, turnNumber: 0, index: -N..-1 }`
  - 塞到 `parsedSentences` 前
- `PlayPanel` 开场时调用 `seedOpeningSentences(manifest.openingMessages, manifest.defaultScene ?? { background: null, sprites: [] })`
- 首次渲染前把 `currentScene` 也置为 `defaultScene`（避免空窗）

**验收**
咖啡馆剧本的两条 opening 出现在 parsedSentences 前段；玩家进游戏先手动推两次（开场 narration），再一次才触发 LLM 产第三条。

---

### Step 1.4 — Sentence 级打字机（dialogue + narration 共用）

**新增**
- `src/ui/play/vn/useDialogTypewriter.ts` — hook：传入 `text`、`cps`、`skipTo?` → 返回当前显示的 partial 文本 + `done: boolean`

**DialogBox 行为**
- 切到新 Sentence 时 hook 从 0 重算
- 打字进行中 click → 立刻全显（`skipTo = true` 触发 hook 跳到尾）
- 全显后再 click → VNStage 推下一句
- narration 建议 CPS 更高（80），dialogue 默认 30（从 LLMSettingsPanel 的"打字机速度"读取）

**验收**
文字逐字出现；中途 click 立刻全显；再次 click 进入下一句；短 narration 一闪而过也 OK。

---

### Step 1.5 — scene-change 过渡动效

**依赖**：复用已有的 Framer Motion（仓库里已有 motion/react 的使用）

**实现**
- `SceneBackground` — background id 变化触发 crossfade（默认 fade 300ms；`cut` 0ms；`dissolve` 500ms）
- `SpriteLayer` — 进场/退场独立 fade-in/fade-out 200ms
- Sentence 的 `transition` 字段传给 VNStage，SceneBackground 根据它选 variant

**验收**
咖啡馆剧本 LLM 切到 `cafe_window` 时能看到背景 crossfade；sakuya 出现时淡入。

---

### Step 1.6 — Backlog 侧拉面板（只读）

**新增**
- `src/ui/play/vn/Backlog.tsx` — 右侧 drawer，触发按钮在屏幕右上
- 列出 `parsedSentences` 全量（过滤掉 `kind:'scene_change'`？暂时都展示）
- 每条显示：speaker（dialogue 才有）+ text 前 N 字符；hover 展开全文
- 背景缩略：用 sceneRef.background id 显示小色块+文字

**不做**
- 点击条目回跳游标（MVP 只读）
- 搜索 / 过滤

**验收**
玩十几句后打开 backlog 能看完整历史；关掉不影响游戏状态。

---

### Step 1.7 — 删老 NarrativeView + EditorDebugPanel 加 raw streaming tab

**删**
- `src/ui/NarrativeView.tsx`（558 行）
- `src/ui/ConversationMinimap.tsx`（如果存在）
- `src/ui/EntryBlock.tsx` / `GenerateBlock.tsx` 等只被 NarrativeView 用的子组件（grep 确认无其他引用再删）

**改 game-store**
- 删字段：`entries / streamingEntryId`
- 删 actions：`beginStreamingEntry / appendToStreamingEntry / finalizeStreamingEntry / appendEntry`
- 删相关 WS handler 调用

**改 ws-client-emitter**
- `begin-streaming / text-chunk / finalize` 事件保留接收（后端还在发），但不再写 store——只让新增的 "raw streaming" tab 订阅

**新增 EditorDebugPanel "raw streaming" tab**
- 独立 `useRef` 累加 text-chunk 得到 raw LLM 输出
- 显示最近一次 generate 的完整原文（包含 XML-lite 标签），帮 admin 排查解析问题
- 不持久化，重置清空

**验收**
- `grep -rE '\bentries\b|streamingEntryId' src/` 基本零 hit（除了无关的 `queryEntries` 之类）
- EditorDebugPanel "raw streaming" tab 能看到带 `<d s="sakuya" to="player">...</d>` 的原始文本

---

### Step 1.8 — InputPanel / choices 叠加在 VN 层上

**改 `src/ui/InputPanel.tsx`**
- 把它的挂载位置从"下方独立区"改为"浮在对话框上方"
- choices（`InputHint`）出现时：
  - VNStage 暂停推进（即使 advance() 被调也不动）
  - 玩家选了一个 → 送入 WS → 清空 choices → 继续推进
- 文本输入（`InputType='text'`）同理，提交后继续推进

**验收**
LLM 调 `signal_input_needed` 后出现 4 个选项浮在对话框上；玩家点选项 → 选项消失 → 下一条 Sentence 触发。

---

### Step 1.9 — 资产 URL 空值兜底

**`SceneBackground`**
- `manifest.backgrounds` 里的 `BackgroundAsset.assetUrl` 空/找不到 → 纯色块（深灰）+ 中央文字 `[background: cafe_interior]`

**`SpriteLayer`**
- `CharacterAsset.sprites[].assetUrl` 空 → 圆角矩形卡片（根据 position 靠左/中/右）+ 内部文字 `sakuya · smile`，半透明底色

**不改**
- M4 OSS 上线时只需在 manifest 里补 assetUrl，UI 组件逻辑自动换图

**验收**
咖啡馆剧本所有 assetUrl 都没填，进游戏看不到红叉 / broken image；只显示占位；占位数量对（cafe_interior 一个背景 + sakuya 1~3 个立绘切换）

---

### Step 1.10 — 验证 + 拆 commit

**类型检查**
- `bun tsc --noEmit`（根目录）clean
- `cd server && bun test` 95/95 pass

**Preview 手跑**
1. 登录 admin（admin/admin123）
2. 首页点"咖啡馆测试 M3" → 建新 playthrough
3. 看到 cafe_interior 背景 + 对话框（对话框显示第一条 opening narration）
4. 点屏幕 → 推第二条 opening → 推到 LLM 首次 generate
5. LLM 调 change_scene → 看到背景/立绘淡入
6. dialogue 出现时 speaker 显示 "sakuya"，narration 时空
7. 出现 signal_input_needed choices → 选一个 → 继续
8. 打开 backlog → 历史全在
9. 编辑器侧打开 raw streaming tab → 能看到 `<d s="sakuya">...</d>` 原文

**Commit 拆分**
- `feat(m1a): VN 三层骨架 + click-to-advance + opening sentences 前置` (1.1-1.3)
- `feat(m1b): 打字机 + scene-change 动效 + backlog + 资产占位 + choices 叠加` (1.4-1.6, 1.8-1.9)
- `refactor(m1c): 删老 NarrativeView + entries store 字段 + dev raw streaming tab` (1.7)

---

## M2：编辑器侧 VN 资产管理（5 步，M1 之后做）

### Step 2.1 — EditorPage manifest state 扩展 + 加载/保存链路

**改 `src/ui/editor/EditorPage.tsx`**
- 新增 state：`characters / backgrounds / defaultScene`（各自 setXxx）
- `applyRecordToEditor()` 从 manifest 加载
- `handleSaveScript()` 组装 manifest 时 spread 进去

**验收**
手动往 manifest 塞 sakuya / cafe_interior → 加载进编辑器 state 正确；不改任何 UI 就保存 → 后端 script_versions.manifest 字段完好。

---

### Step 2.2 — `<CharactersSection>` 组件（在 ScriptInfoPanel 内）

**UI**
- 列表行：`id / displayName / N sprites [展开] [删除]`
- 展开编辑：`displayName` 输入、`sprites` 子列表每行 `id / label / [删除]` + `[+ 新 sprite]`
- 新增角色：对话框（id + displayName）
- id 校验：snake_case 正则 `^[a-z][a-z0-9_]*$` + 非空 + 不重复

**验收**
从空剧本开始建 sakuya 三表情；保存→刷新→load 数据完整。

---

### Step 2.3 — `<BackgroundsSection>`

**UI**
- 列表行：`id / label / [删除]`
- 单行新增：`id` input + `label` input + `[+]` 按钮
- 同 id 校验

**验收**
建 cafe_interior / cafe_window；save/load 往返。

---

### Step 2.4 — `<DefaultSceneSection>`

**UI**
- 开场背景：下拉（选项来自 `backgrounds[]`；空时 disabled 提示"先加背景"）
- 开场立绘（可选）：开关 → 展开 3 个下拉（角色 / 表情 / 位置）
  - 角色下拉来自 `characters[]`
  - 表情下拉来自所选角色的 `sprites[]`
  - 位置下拉 `left / center / right`

**`defaultScene` 最终形状**
```ts
{ background: 'cafe_interior', sprites: [{ id: 'sakuya', emotion: 'smile', position: 'center' }] }
// 或 sprites: [] 如果关了开场立绘
```

**验收**
defaultScene 配置后保存；玩家开游戏时 M1 渲染的第一帧正好是这个配置。

---

### Step 2.5 — 集成 ScriptInfoPanel + tsc + preview E2E

**集成**
- 三个 section 挂进 `ScriptInfoPanel.tsx`（新 tab 或 collapsed sections）

**验证**
- `bun tsc --noEmit` clean
- Preview：编辑器建新剧本 → 加 1 角色 3 sprites / 2 背景 / defaultScene → 保存发布 → 首页看到卡 → 玩游戏走 M1 渲染链
- 95 server tests 全绿

**Commit 拆分**
- `feat(m2a): EditorPage manifest 扩展 + CharactersSection` (2.1-2.2)
- `feat(m2b): BackgroundsSection + DefaultSceneSection + 集成` (2.3-2.5)

---

## 验证总览

| 层 | 验证方式 |
|---|---|
| logic | `bun tsc --noEmit` + narrative-parser 单测（M3 已有）+ server tests 95/95 |
| UI | preview 走 E2E 流程（上面 M1.10 / M2.5 里列了） |
| e2e | 咖啡馆 M3 剧本能以 VN UI 跑通；编辑器能造出带资产的新剧本 |

## 遗留到后续 milestone

- **M4 OSS 资产 pipeline**：上传、压缩、CDN、URL 回填
- **auto / skip 推进模式**（有 save/load 再说）
- **立绘位置拖拽编辑**（M2 只做下拉选，可视化拖拽是 nice-to-have）
- **Backlog 点击回跳**（需要 Sentence index 回跳 + 分支重算机制）
- **章节切换过渡动画 / 章节封面卡**
- **BGM / 音效 / 语音**
