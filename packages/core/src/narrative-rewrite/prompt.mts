/**
 * Narrative Rewrite — Prompt 构造
 *
 * 把 IVN XML 协议的核心规则 + parser 解读 hint + 原文打包成 system + user
 * 两段消息。规则段从 engine-rules.mts 抽取，但去掉跟剧本/工具/视觉子标签
 * 相关的部分——rewriter 只做"reformat 容器分配 + 微调措辞"，不改剧情。
 */

import type { RewriteInput } from '#internal/narrative-rewrite/types';

// ============================================================================
// System Prompt（静态规则段）
// ============================================================================

/**
 * rewriter 的 system prompt。设计原则：
 * - 简短（< 1500 token），让 LLM 聚焦在 reformat 任务
 * - 把"不要补剧情"等核心硬约束放在最前面
 * - IVN XML 协议规则用 RFC 风格清晰列出
 * - 反面示范贴近实际 production 出现的错误模式
 */
export function buildRewriteSystemPrompt(): string {
  return REWRITER_SYSTEM_PROMPT;
}

const REWRITER_SYSTEM_PROMPT = `你是 IVN（Interactive Visual Novel）引擎的 narrative rewriter。

# 任务

下面会给你一份 GM（剧情主持）这一轮的**原稿**和 parser 的**解读结果**。
判断原稿是否符合 IVN XML 协议；如果不符合，按规则**重写**这一轮的输出。

# 硬约束（违反会被 reject）

1. **不补剧情**：不新增对白、动作、场景、角色。原稿里没有的内容**绝对不能**出现在你的输出。
2. **不改剧情走向**：人物关系、情绪、决定都按原稿。
3. **允许微调措辞**：拆"他说A，做了B，又说C"成 \`<dialogue>\` + \`<narration>\` + \`<dialogue>\` 时，可以小幅润色衔接，但不能改变意思。
4. **第一个字符必须是 \`<\`**：不要任何前置说明、致歉、解释。
5. **整段 IVN XML，不要任何注释/markdown 代码块/解释文字**。

# IVN XML 协议（顶层容器三种）

## \`<dialogue>\` —— 角色对白
\`\`\`
<dialogue speaker="<角色id>" to="<被说者id|*>" hear="<旁听者ids>">
  正文只装该角色的直接引语
</dialogue>
\`\`\`
- \`speaker\` 必填；id 必须在白名单内（见后面 manifest）；不在白名单的路人用 \`__npc__<显示名>\`（例：\`__npc__保安\`）
- 任何旁白/动作/表情/第三人称描写**必须**拆出去走 \`<narration>\`
- 不要把 \`你\` / \`我\` / \`他\` 等代词当 id

## \`<narration>\` —— 旁白/描写
\`\`\`
<narration>
  环境/动作/心理/第三人称描写
</narration>
\`\`\`
- 没有具体说话人的内容（环境音、广播、旁白）一律走 \`<narration>\`
- 第二人称"你"自由出现在正文里，**不能**当 id

## \`<scratch>\` —— 内部思考（玩家看不到）
\`\`\`
<scratch>
  我先查 state 然后决定方向
</scratch>
\`\`\`
- 给自己看的元叙述、规划、状态报告
- 玩家看不到，但保留在历史里
- **rewriter 输出可以省略 scratch**——除非原稿的 scratch 内容对下一轮决策真有用

# 输出纪律（硬性禁止）

- 第一个字符必须是 \`<\`
- 每轮回复必须至少包含**一个** \`<dialogue>\` 或 \`<narration>\`
- 不要写容器之外的裸文本
- 不要写 \`<scene>\` / \`<choice>\` 等其他标签
- 不要在属性里填 \`?\` 占位符；想不出就省略

# 反面示范

❌ 把动作描写塞进 \`<dialogue>\`：
\`\`\`
<dialogue speaker="__npc__中年男人" to="player">
  "俄罗斯？"他用大拇指指了指你，"那个方向来的？"
</dialogue>
\`\`\`

✅ 拆三个单元（台词→动作→台词）：
\`\`\`
<dialogue speaker="__npc__中年男人" to="player">"俄罗斯？"</dialogue>
<narration>他用大拇指指了指你。</narration>
<dialogue speaker="__npc__中年男人" to="player">"那个方向来的？"</dialogue>
\`\`\`

❌ 写 \`<scratch>\` 然后没有任何 \`<dialogue>\` / \`<narration>\`：玩家看到空白屏幕。

❌ 整段裸文本（没包在容器里）：玩家看不到，会被引擎降级丢弃。

# 你的输出

只输出 IVN XML，不要任何解释。如果原稿已经基本合规，可以做最小修改原样输出。`;

// ============================================================================
// User Message 构造
// ============================================================================

export function buildRewriteUserMessage(input: RewriteInput): string {
  const sections = [
    '# 原稿（GM 这一轮的全部输出）',
    '```',
    input.rawText,
    '```',
    '',
    '# Parser 解读',
    formatParserView(input),
    '',
    '# Manifest 白名单（id 校验用）',
    formatManifest(input),
    '',
    '# 任务',
    '按规则重写以上原稿。如果原稿已基本合规，可做最小改动。',
    '只输出重写后的 IVN XML，第一个字符必须是 `<`。',
  ];
  return sections.join('\n');
}

function formatParserView(input: RewriteInput): string {
  const view = input.parserView;
  const lines: string[] = [];
  lines.push(`- sentence 数：${view.sentences.length}`);
  lines.push(`- scratch 块数：${view.scratchCount}`);
  lines.push(`- looksBroken：${view.looksBroken ? 'true（疑似有结构/语义问题）' : 'false'}`);
  if (view.degrades.length > 0) {
    lines.push('- degrades:');
    for (const d of view.degrades) {
      const detail = typeof d.detail === 'string' ? d.detail : JSON.stringify(d.detail);
      const truncated = detail.length > 80 ? detail.slice(0, 80) + '...' : detail;
      lines.push(`  · ${d.code}: ${truncated}`);
    }
  } else {
    lines.push('- degrades: 无');
  }
  if (view.sentences.length > 0) {
    lines.push('- sentences (parser 切出的容器):');
    for (const s of view.sentences) {
      const text = sentenceText(s);
      const head = text.length > 60 ? text.slice(0, 60) + '…' : text;
      lines.push(`  · ${s.kind}${formatSentenceMeta(s)}: ${JSON.stringify(head)}`);
    }
  }
  return lines.join('\n');
}

function sentenceText(s: { kind: string; text?: string }): string {
  return s.text ?? '';
}

function formatSentenceMeta(s: { kind: string; pf?: { speaker?: string } }): string {
  if (s.kind === 'dialogue' && s.pf?.speaker) return ` (speaker=${s.pf.speaker})`;
  return '';
}

function formatManifest(input: RewriteInput): string {
  const m = input.manifest;
  const lines: string[] = [];
  lines.push(`- 角色 id: ${formatIdList(m.characterIds)}`);
  lines.push(`- 背景 id: ${formatIdList(m.backgroundIds)}`);
  if (Object.keys(m.moodsByCharacter).length > 0) {
    lines.push('- 每角色情绪:');
    for (const [charId, moods] of Object.entries(m.moodsByCharacter)) {
      lines.push(`  · ${charId}: ${formatIdList([...moods])}`);
    }
  }
  return lines.join('\n');
}

function formatIdList(ids: readonly string[]): string {
  if (ids.length === 0) return '（空）';
  return ids.map((id) => `\`${id}\``).join(', ');
}
