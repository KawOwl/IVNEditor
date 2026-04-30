# IVN v3 HTML 协议（实验）

把 IVN GM 输出从自定义 XML 协议（`<narration>` / `<dialogue>` / `<sprite>` /
`signal_input_needed` tool / `update_state` tool）迁移到**纯 HTML + data-\* 属性**
形态。目标：LLM 不调任何 tool，所有结构信号和状态变更都走 HTML。

## 标签映射

| IVN 概念 | HTML 标签 | 属性 |
|---|---|---|
| 旁白 | `<p>` | （无） |
| 对话 | `<p data-speaker="...">` | speaker |
| 元思考（玩家不可见） | `<div data-kind="scratch">` | data-kind |
| 切背景 | `<div data-bg="bg_id"><p>...</p></div>` | data-bg |
| 切立绘 | `<div data-sprite="char/mood/pos"><p>...</p></div>` | data-sprite |
| 选项（替代 signal_input_needed） | `<ul data-input="choices"><li>...</li></ul>` | data-input |
| 状态更新（替代 update_state） | `<script type="application/x-state">{...}</script>` | type |

## 标签选用依据

LLM 训练频率优先，data-\* 属性撑语义。

| 原候选 | 改用 | 原因 |
|---|---|---|
| `<aside data-kind="scratch">` | `<div data-kind="scratch">` | div 训练频率显著更高 |
| `<figure data-bg\|data-sprite>` | `<div data-bg\|data-sprite>` | figure 多与 `<img>` 配，会反向 prime LLM emit `<img>`；语义错配（figure="自含+caption"） |
| `<menu data-input="choices">` | `<ul data-input="choices">` | menu 在 HTML4 deprecated 后被 ul 大幅替代 |
| `<p data-speaker>` | 保持 | p 训练高频 + data-speaker 语义清晰 |
| `<script type="application/x-state">` | 保持 | script + JSON 是 web 已知模式（JSON-LD / structured data） |

## Prompt 纪律

- **不在 prompt 中提及任何 IVN-XML legacy tag**（`<narration>` / `<dialogue>`
  / `<sprite>` / `<stage>` / `<scratch>`）。理由：LLM 上下文里本来没这些 token，
  写在 prohibition 里反而引入污染 / 反向 prime。
- Parser 仍保留 `LEGACY_TAGS` 检测 + warning，作为防御层（如 LLM 训练数据偶发
  emit / 测试 fixture 含旧形态）。

## 状态语义

- `<script type="application/x-state">` 内是合法 JSON 对象
- **整体覆盖**语义：JSON 列出的字段被覆盖，未列出的字段不变
- 不支持 partial inc/del/push 语法 —— LLM 自己算好新值再 set
- 实验阶段简化版；后续若有需求再扩 ops

## 文件

| 文件 | 职责 |
|---|---|
| `types.mts` | `NarrativeUnit` / `ChoicesBlock` / `StateUpdate` / `ParseResult` |
| `parser.mts` | `parseHtmlProtocol(html) → ParseResult`，buffered，htmlparser2 + domhandler |
| `system-prompt.mts` | `buildSystemPrompt(state)` 注入当前 state JSON snapshot |

入口：`../exp-html.mts`。

## 已知局限

- Parser 是 buffered（每 turn 末一次性 parse），非流式。streaming 留 v2 优化
- 仅支持 `set` op（整体覆盖）。inc/del/push 留 v2
- 立绘 `data-sprite` 解析 `char/mood/pos` 三段式，缺段静默接受（mood/pos 可省）
- `<script type="application/x-state">` 内若 JSON parse 失败 → warning，不抛错
- 同 turn 多个 `<ul data-input="choices">` 或多个 `<script application/x-state>`
  → warning，仅取第一组

## 解析坑（已修）

`<script>` / `<style>` 在 htmlparser2 / domhandler 中 `ElementType` 为 `'script'`
/ `'style'`，**不是 `'tag'`**。`isElement` 若仅比 `ElementType.Tag` 会过滤掉
`<script>` 节点 → state 永远 null。改用 `domhandler.isTag()` 涵盖三类（Tag /
Script / Style）。
