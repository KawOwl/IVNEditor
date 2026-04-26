/**
 * Narrative Rewrite — Prompt 构造（同源 engine-rules.mts）
 *
 * 把 IVN XML 协议的核心规则（容器规范 / ad-hoc speaker 三档分级 / 输出纪律 /
 * 反面示范）从 engine-rules.mts **直接复用**——保证主路径跟 rewriter 看到的
 * 协议字节同源。改进 A（2026-04-26）落地：trace bab24e15 / 227cb1d0 暴露的
 * "rewriter prompt 跟主 prompt 漂移"问题（rewriter 不知道 ad-hoc 禁泛称等
 * 新规则），通过共享子段 export 治掉。
 */

import {
  ENGINE_RULES_CONTAINER_SPEC_V2,
  ENGINE_RULES_ADHOC_SPEAKER_V2,
  ENGINE_RULES_NARRATION_FALLBACK_V2,
  ENGINE_RULES_OUTPUT_DISCIPLINE_V2,
  ENGINE_RULES_ANTI_EXAMPLES_V2,
  buildEngineRulesWhitelistV2,
} from '#internal/engine-rules';
import type { RewriteInput } from '#internal/narrative-rewrite/types';

// ============================================================================
// rewriter 专属段：任务定义 / 硬约束（不补剧情等）
// ============================================================================

/** rewriter 任务定义 + 硬约束。注意保持字节稳定，便于 prompt cache 复用。 */
const REWRITER_TASK_INTRO =
  `你是 IVN（Interactive Visual Novel）引擎的 narrative rewriter。\n` +
  `\n` +
  `# 任务\n` +
  `\n` +
  `下面会给你一份 GM（剧情主持）这一轮的**原稿**和 parser 的**解读结果**。\n` +
  `判断原稿是否符合 IVN XML 协议；如果不符合，按规则**重写**这一轮的输出。\n`;

const REWRITER_HARD_CONSTRAINTS =
  `\n# 硬约束（违反会被 reject）\n` +
  `\n` +
  `1. **不补剧情**：不新增对白、动作、场景、角色。原稿里没有的内容**绝对不能**出现在你的输出。\n` +
  `2. **不改剧情走向**：人物关系、情绪、决定都按原稿。\n` +
  `3. **允许微调措辞**：拆"他说A，做了B，又说C"成 \`<dialogue>\` + \`<narration>\` + \`<dialogue>\` 时，可以小幅润色衔接，但不能改变意思。\n` +
  `4. **第一个字符必须是 \`<\`**：不要任何前置说明、致歉、解释。\n` +
  `5. **整段 IVN XML，不要任何注释/markdown 代码块/解释文字**。\n` +
  `\n` +
  `# IVN XML 协议\n`;

const REWRITER_TASK_OUTRO =
  `\n# 你的输出\n` +
  `\n` +
  `只输出 IVN XML，不要任何解释。如果原稿已经基本合规，可以做最小修改原样输出；` +
  `如果发现 ad-hoc speaker 是禁止的关系代词（"另一人"/"某人"/"其中一个"等），把那段拆到 \`<narration>\`。\n`;

// ============================================================================
// System Prompt 构造
// ============================================================================

/**
 * rewriter 的 system prompt。结构：
 * - rewriter 专属任务说明 + 硬约束
 * - 共享：容器规范 + ad-hoc speaker 三档分级 + narration fallback + 输出纪律 + 反面示范
 *
 * 跟主路径 engine-rules.mts 的 v2 narrative format 段**共享子段 const**，
 * 修改一处两边同步。
 */
export function buildRewriteSystemPrompt(): string {
  return (
    REWRITER_TASK_INTRO +
    REWRITER_HARD_CONSTRAINTS +
    ENGINE_RULES_CONTAINER_SPEC_V2 +
    ENGINE_RULES_ADHOC_SPEAKER_V2 +
    ENGINE_RULES_NARRATION_FALLBACK_V2 +
    ENGINE_RULES_OUTPUT_DISCIPLINE_V2 +
    ENGINE_RULES_ANTI_EXAMPLES_V2 +
    REWRITER_TASK_OUTRO
  );
}

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
    PARSER_VIEW_INSTRUCTIONS,
    '',
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

/**
 * 软提醒（C1，2026-04-26）：parser degrade 是事实信息**不是修复指令**。
 *
 * 历史教训（trace 227cb1d0 + 用户反馈）：把 degrade 机械标"必修 + 修复方向"
 * 会误判——不同 degrade 需要的语义判断完全不同：
 *   - `bare-text-outside-container` 既可能该包 `<narration>` 也可能该进 `<scratch>`
 *   - `dialogue-adhoc-speaker` 既可能合规（`__npc__保安`）也可能禁止（`__npc__另一人`）
 *   - `container-truncated` 不能补内容（违反"不补剧情"硬约束）
 *
 * 让 rewriter 看 raw 上下文 + system prompt 协议规则**自行做语义判断**，
 * 比代码侧机械标记更稳。本段是判断框架 + 几个最容易误判类的判断要点。
 */
const PARSER_VIEW_INSTRUCTIONS =
  `下面是 parser 解读 raw 时记录的事实信息（**不是修复指令**）。每条 degrade 你需要：\n` +
  `- 在 raw 里定位到对应位置（detail 给了文本片段 / id / 容器名）\n` +
  `- 按 system prompt 协议规则做语义判断\n` +
  `- 决定是否修复、怎么修复\n` +
  `\n` +
  `判断要点（最容易误判的几类）：\n` +
  `- \`bare-text-outside-container\`：裸文本是**元描述**（"让我先查 state…"）→ 包进 \`<scratch>\`；是**叙事内容** → 包进 \`<narration>\`\n` +
  `- \`dialogue-adhoc-speaker\`：按 system prompt 里的 \`__npc__\` **三档分级**判断（✅ 具体身份 / ⚠️ 声音形容 / ❌ 关系代词 → 拆 \`<narration>\`）\n` +
  `- \`container-truncated\`：原文被 token 上限截断，**不要试图补完**——保留截断的内容（含 \`truncated:true\` 标记），rewrite 输出原样保持`;

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
  // 把精简版 manifest 转成 main-path 同款的 buildEngineRulesWhitelistV2 输入
  // 以便 prompt 里白名单段跟主路径**字节同款**——LLM 看到的格式完全一致。
  const characters = input.manifest.characterIds.map((id) => ({
    id,
    sprites: (input.manifest.moodsByCharacter[id] ?? []).map((moodId) => ({ id: moodId })),
  }));
  const backgrounds = input.manifest.backgroundIds.map((id) => ({ id }));
  return buildEngineRulesWhitelistV2(characters, backgrounds).trimStart();
}
