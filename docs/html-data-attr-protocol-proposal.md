# HTML + data-attr 叙事协议提案（Design Note，未实施）

**状态**：提案。仅记录权衡，等 streaming + fixup（S.1）落地 + staging 数据 1-2 周后再决定是否启动迁移。

**日期**：2026-04-29

---

## 背景

当前 IVN XML 协议以自定义顶层容器（`<narration>` / `<dialogue>` / `<scratch>`）+ 自定义视觉子标签（`<background/>` / `<sprite/>` / `<stage/>`）+ 自定义属性（speaker / to / hear / eavesdroppers / mood / position）描述 GM 的一轮叙事输出。这套协议存在三类 LLM 端噪音，已在 staging Langfuse 上观察到：

1. **闭合标签字面错字**：例如 `</narring>` 替代 `</narration>`、`</narratoin>`、`</dialouge>`。原因是 deepseek-v4-flash 蒸馏档在长上下文 + 中英混杂模式下，subword token 之间存在低概率竞争（`-ation>` vs `-ing>`、`-ation>` vs `-ative>`）。每次发出闭合 tag 都是一次独立采样，错字率随 unit 数量线性叠加。
2. **工具名写成假 XML 顶层标签**：例如 `<signal_input_needed prompt_hint="..." choices='[...]' />`、`<end_scenario reason="..." />`。模型在长 XML 模式惯性下，把本应通过 SDK function-calling 通道发出的 tool call 当成 inline XML tag 写入文本流。引擎检测不到真正的 terminal tool → 触发 followup 重试 → 同时 parser 报 `unknown-toplevel-tag` → 触发 rewriter，单一错误导致**双倍延迟**（典型 +6.6s followup + +4.6s rewriter）。
3. **协议陌生导致 fluency 损失**：IVN XML 是项目特定协议，模型训练数据里没见过。这导致模型偶尔在 attribute / 子标签 / 文本三种模式间切换时局部塌方，产生 `<narration>` 内嵌套 `<narration>` 这种结构错误，或属性值漏引号。

S.1 的 streaming + parser-v2 兜底能消化前两类的**症状**（错字归类到 `container-truncated`、伪 tool tag 触发 rewriter fallback），但**根因**仍在协议格式本身。这份文档讨论一个更结构性的替代方案。

---

## 提案

把 IVN 协议从"自定义 XML 标签集合"换成"HTML 标准标签 + `data-*` 属性表达类型与元数据"。

### 形态对照

**当前 IVN XML**：

```xml
<scratch>
玩家进入第3轮，引入卡琳娜冲突场景
</scratch>

<narration>
  <background scene="dark_s02" />
  你向声音传来的方向走去。绕过一栋废弃的杂货铺。
</narration>

<narration>
  <sprite char="carina" mood="normal_2" position="left" />
  卡琳娜站在你面前，正眼看着你。
</narration>

<dialogue speaker="carina" to="pazz">
  "外地人？"
</dialogue>

<narration>
  她的语气换了一种——像在问一个有趣的谜题。
</narration>

<dialogue speaker="carina">
  "不可能是游客，游客不会走到这里。"
</dialogue>
```

**HTML + data-attr**：

```html
<aside data-kind="scratch">
玩家进入第3轮，引入卡琳娜冲突场景
</aside>

<figure data-bg="dark_s02">
<p>你向声音传来的方向走去。绕过一栋废弃的杂货铺。</p>
</figure>

<figure data-sprite="carina/normal_2/left">
<p>卡琳娜站在你面前，正眼看着你。</p>
</figure>

<p data-speaker="carina" data-to="pazz">"外地人？"</p>

<p>她的语气换了一种——像在问一个有趣的谜题。</p>

<p data-speaker="carina">"不可能是游客，游客不会走到这里。"</p>
```

### 映射规则

| IVN 概念 | HTML 形态 | 备注 |
|---|---|---|
| narration | `<p>`（无 `data-speaker`） | 段落是 narration 的语义默认 |
| dialogue | `<p data-speaker="x">` | speaker 即此段为 dialogue 的判定 |
| scratch | `<aside data-kind="scratch">` | `<aside>` 语义"边缘内容" 对应"玩家不可见的元思考" |
| background 切换 | `<figure data-bg="...">` 包裹后续 unit | `<figure>` 语义"自带 caption 的独立内容" 对应"带视觉态的单元" |
| sprite 切换 | `<figure data-sprite="char/mood/pos">` | 内嵌一个 `<p>` 作为单元正文 |
| stage clear | `<figure data-stage="clear">` | 视觉态切换的特例 |
| to / hear / eavesdroppers | `data-to` / `data-hear` / `data-eavesdroppers` | 属性扩展走 `data-*` 命名空间 |
| mood / position 在 dialogue 内 | `data-mood` / `data-position`（弃用，已强制 center） | mood 仍可用于 sprite 切换；position V.12 起 UI 强制 center |

### 解析侧

- **Allowlist tag set**：`<p>`、`<aside>`、`<figure>` 三个语义容器；`<span>` / `<em>` / `<strong>` 等模型可能注入的"装饰性"标签由 parser 静默吞掉，不进 IR
- **Allowlist `data-*` keys**：`kind` / `speaker` / `to` / `hear` / `eavesdroppers` / `bg` / `sprite` / `stage` / `mood`；其他键 parser 直接丢弃
- **Levenshtein 模糊匹配**：仍保留——typo 的属性键（`data-spker`）按编辑距离 ≤ 2 匹配回正名
- **`<p>` 的 dialogue 判定**：存在 `data-speaker` → dialogue；无 `data-speaker` → narration。speaker 不在 manifest 白名单 → 降级 narration（保持现有 V.11 行为）

### Manifest 不变

`characters` / `backgrounds` / `stateSchema` / `memoryConfig` / `promptAssemblyOrder` 等编辑器维护的剧本配置不需要改动——格式迁移只换 GM 输出协议，manifest 是 GM 输入的另一个维度。

---

## 收益分析

### 1. 闭合标签错字率下降

**机制**：`</p>` / `</aside>` / `</figure>` 在 BPE 词表里大概率是**单个 token**（HTML 高频项），模型从不"在 token 内部塌方"。即使是多 token 切分的情况，所有备选路径都是合法 HTML（`</span>` / `</div>`），模型从未在训练数据里见过 `</narring>` 这类错字，因此 next-token 分布对 typo 的支持极低。

**预期**：闭合标签错字从当前的 ~ε% 命中（按 staging trace 估计 5-10% 的 turn 含至少一处）降到接近 0。

### 2. 工具名假 XML 大幅减少

**机制**：HTML 语法集合是封闭的，模型对"能写出哪些 tag"的先验更强。`<signal_input_needed/>` 这种"明显非 HTML"的标签在 HTML 模式下会被模型自身分布拒绝——模型不会写 `<my_custom_tag/>` 在 HTML 文档里。

**预期**：`unknown-toplevel-tag: signal_input_needed` 这一类 degrade 命中率从当前的不可忽略（trace 里出现过几次）降到 < 0.1%。followup 重试链路需要触发的频率也跟着下降。

### 3. 模型 fluency 提升

**机制**：HTML 是模型最熟悉的结构化文本格式之一，训练数据占比远超任何 custom XML 协议。模型在 HTML 模式下生成 attribute、嵌套结构、自闭合 tag 都更稳定。

**预期**：偏离协议的"创意性塌方"（嵌套位置错误、属性值漏引号、半个 tag 写完忘记继续）整体下降一个数量级。

### 4. 编辑器与人工审阅友好

- 任何 IDE/浏览器都有 HTML 语法高亮，省去自定义 highlighter
- raw output 直接用浏览器打开就能看出结构（虽然渲染样式不对，但层级和文本可读）
- code review 时人能直接看懂 markup 含义，不需要先学协议

### 5. Token 经济学（持平到略改善）

字符数对比（典型 turn ~10 unit）：
- IVN XML markup：~140 字符
- HTML + data-attr markup：~200 字符（+ 40%）

但 token 数对比：
- IVN XML：custom tag 拆 3-4 token + 自定义属性（`speaker=`）拆 2-3 token
- HTML + data-attr：标准 tag 多数为 1 token + `data-` 前缀虽多但每个也接近 1 token

按 deepseek BPE 估算，HTML 版本 markup 总 token 数大致**持平或略低**。中文叙事正文 token 数完全不变。

### 6. 跨模型可移植

IVN XML 是项目专有 → 换模型（Claude / GPT / Qwen / Gemini）需重新调教 fluency。
HTML 是所有 LLM 共通熟悉的格式 → 换模型几乎零调试成本。

这是**长期 strategic 收益**，不直接影响当前指标。

---

## 成本与风险

### 1. 迁移工作量

- system prompt 重写：当前 prompt（240 KB / 3968 行）约 1/3 在描述 IVN XML 协议规则、容器规范、反面示范。需要全部用 HTML + data-attr 重新表述。预估 1-2 周纯 prompt 工作。
- parser-v2 改造：新增 HTML 标签 dispatcher、`data-*` allowlist filter、HTML 装饰标签静默吞逻辑。reducer 主流程不动，但 tag-schema 和 reducer 的 onopentag/onclosetag 分支需要适配。预估 3-5 天。
- IR 存储双格式兼容：现存 playthrough archive 是 IVN XML 格式，迁移期 parser 需要 dual-format 路由。可以按 manifest 上一个新字段（`narrative_protocol_version: 'ivn-xml-v1' | 'html-v1'`）区分。
- 测试套件：reducer / parser / inheritance 现有 ~40 用例需复制一份 HTML 版本，确保两个协议的语义一致性。
- 编剧侧：如果有人在剧本 prompt 里举 IVN XML 的例子，需要同步更新——但这是渐进式的（老剧本继续用老协议）。

总体迁移成本估计 2-3 周开发 + 1-2 周观察期。

### 2. HTML 幻觉污染

模型熟悉 HTML 但你不要的标签：
- `<br>`、`<hr>`、`<strong>`、`<em>`、`<i>`、`<b>`、`<u>`
- `<a href="...">`、`<img src="...">`
- `<table>` / `<tr>` / `<td>`、`<ul>` / `<li>` / `<ol>`
- `<script>`、`<style>`（潜在安全风险，即便 server-side 不渲染）

**缓解**：parser 维护 allowlist，allowlist 之外的 tag 静默吞掉（保留内部文本），allowlist 之外的属性键直接丢。这增加 parser 负担，但比 fuzzy match 简单——白名单查表 vs 编辑距离匹配。

**估计噪音水平**：在 production 模式下，模型按 system prompt 的硬约束很少注入这些标签，但偶发概率 > 0。需要 staging 实测看命中率。

### 3. 语义清晰度可能下降

- IVN XML：`<dialogue speaker="carina">"..."</dialogue>` 一眼看出"这是 dialogue"
- HTML：`<p data-speaker="carina">"..."</p>` 需要扫到属性才知道"哦这是 dialogue"

对 parser 是 O(1) 区别（attribute lookup），对人类阅读 raw text 略增加扫描成本——但这跟 1.5 节"raw 直接打开浏览器看"的收益相互抵消（HTML 渲染至少能给个层级感）。

### 4. 跟 streaming + fixup 不冲突，但收益部分重叠

S.1 的 streaming + parser-v2 兜底能消化大部分协议级噪音症状。HTML 迁移的增量收益只有：
- 闭合标签错字率（streaming 也救不了字面错字，parser 把它归到 truncated 但 trace 标签不准）
- 工具假 tag 命中率（streaming 不解决这条，HTML 能从源头压低）
- 模型 fluency（streaming 完全不影响，HTML 是边际改善）

**结论**：S.1 落地后边际收益还有，但不是最高优先级。具体增量值多少要看 staging 数据。

---

## 决策矩阵

| 选项 | 适用条件 | 风险 |
|---|---|---|
| A. 不迁移，长期保持 IVN XML | streaming + fixup 落地后 typo / fake-tag 频率 < 0.5% / turn | 留下"协议陌生"这条 long-tail 风险，模型升级时需要重新调教 |
| B. 全量迁移到 HTML + data-attr | streaming 落地后仍有 5%+ turn 命中协议级噪音 | 迁移工作量 2-3 周；prompt 重写期间老剧本要兼容 |
| C. 双协议并行，新剧本用 HTML，老剧本继续 IVN XML | 想要长期演进路径 + 不愿意一次性大改 | parser 复杂度上升（双 dispatch）；编辑器侧也要双轨 |

预期路径：

1. **先做 S.1（streaming + fixup）**——已计划，1-2 周
2. **观察 1-2 周 staging 数据**——埋点 looksBroken 频率、container-truncated 命中率、unknown-toplevel-tag 命中率、rewriter fallback 命中率
3. **如果 looksBroken / fallback 频率仍然 > 5% / turn**——启动 C（双协议并行），新剧本默认 HTML
4. **如果 < 1% / turn**——A（不迁移），把开发资源花在更值钱的地方

---

## 不在本提案范围

- 是否迁移到剧本式（`@speaker: "..."` 段落式）——已在前序讨论排除：单元边界依赖空行，模型不稳定；speaker 提取靠首字符模式，鲁棒性差。HTML + data-attr 比剧本式更适合本应用。
- terminal tool synthesis（parser 看到伪 `<signal_input_needed/>` 自动合成真 tool call）——独立优化，跟协议格式无关，可以在 IVN XML 或 HTML 任一形态下叠加。
- output token 预算限制 / token 上限触发的 truncation——独立问题，跟协议无关。

---

## 附录：DegradeCode 映射表（如启动迁移）

|当前 IVN XML degrade | HTML + data-attr 等价 |
|---|---|
| `dialogue-missing-speaker` | `paragraph-dialogue-missing-speaker`（`<p data-speaker="">` 空值） |
| `dialogue-adhoc-speaker` | 不变（attr value 检查仍然按 manifest 白名单） |
| `dialogue-pronoun-as-speaker` | 不变 |
| `unknown-toplevel-tag` | 改为 `unknown-element`（HTML 标签层面） |
| `unknown-attr` | 改为 `unknown-data-attr`（限于 `data-*` 命名空间） |
| `bg-missing-attr` / `sprite-missing-attr` | `figure-missing-data-bg` / `figure-missing-data-sprite` |
| `container-truncated` | 不变（`<p>` / `<aside>` / `<figure>` 流末未闭合） |
| `bare-text-outside-container` | 简化——HTML 里裸文本不被允许，全部归到 `<p>`；不再有 narration vs scratch 的语义判断（scratch 必须显式 `<aside>`） |

`bare-text-outside-container` 简化是 HTML 协议的一个明显语义清理收益——不再依赖启发式判断"这段裸文本是 meta 还是 narrative"。
