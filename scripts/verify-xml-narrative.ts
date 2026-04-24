#!/usr/bin/env bun
/**
 * verify-xml-narrative.ts
 *
 * 验证 XML-lite 叙事格式对 LLM 的稳定性：
 *   - 对话用 <d s="X" to="Y"> 标签包裹（短属性名）
 *   - 旁白裸写，不加标签
 *   - 场景变化用 <scene> <spr/> 标签
 *   - 玩家选择走 signal_input_needed 工具，不在 XML 中表达
 *
 * 输出每个测试场景的解析结果 + 综合评分。
 *
 * 用法：
 *   DEEPSEEK_API_KEY=sk-xxx bun run scripts/verify-xml-narrative.ts
 *
 * 可配置环境变量（同 verify-deepseek-reasoning.ts）：
 *   DEEPSEEK_BASE_URL  默认 https://api.deepseek.com/v1
 *   DEEPSEEK_MODEL     默认 deepseek-chat
 */

import { streamText, stepCountIs, tool } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { z } from 'zod';

// ============================================================================
// 配置
// ============================================================================

const API_KEY = process.env.DEEPSEEK_API_KEY;
const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1';
const MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat';

if (!API_KEY) {
  console.error('❌ 需要 DEEPSEEK_API_KEY 环境变量');
  process.exit(1);
}

// ============================================================================
// System prompt — 教 LLM XML-lite 格式
// ============================================================================

const SYSTEM_PROMPT = `你是互动小说引擎的叙事模块。按以下规范生成叙事。

## 叙事输出格式（XML-lite）

### 基本规则
- 每句对话用 <d> 标签包裹，带 speaker 等属性
- 旁白/叙述直接写，不加标签，用空行分段
- 场景变化用 <scene> / <spr/> 标签
- 玩家选择通过调用 signal_input_needed 工具实现，不要在 XML 里写 <choice>

### 对话标签（必须用这些短属性名）
<d s="角色id" to="受话人id" hear="旁听id列表" eav="偷听id列表">
  对话内容
</d>

- s：说话人 id（必填）
- to：受话人 id（可选；省略 = 独白/内心）
- to="*"：对在场所有人说（广播）
- to="a,b,c"：对多人说（逗号分隔）
- hear：明知旁听者（speaker 知道他们在场）
- eav：偷听者（speaker 不知道他们在场）

### 场景切换标签
<scene bg="背景id" fx="fade|cut|dissolve">
  <spr id="角色id" em="表情id"/>
</scene>

- bg 省略 = 保留当前背景
- <spr/> 为自闭合标签

### 角色 id
用 snake_case 英文/拼音（如 sakuya / aonkei / teacher）。
**不要用中文显示名**（如"咲夜"），剧本会把 id 映射到显示名。

### 完整示例

<scene bg="classroom_evening" fx="fade">
  <spr id="aonkei" em="praying"/>
</scene>

黄昏的教室里只剩下她一个人。

<d s="aonkei">
（这大概就是我能做的一切了……）
</d>

<d s="aonkei" to="player">
虽然听起来很扯，但情况大概就是这样。
</d>

<d s="aonkei" to="player" hear="teacher">
所以这件事，只能你来做。
</d>

她深深吸了口气。

---

现在根据接下来的场景指示生成叙事。严格按上面的格式，不要加任何元注释或标题。`;

// ============================================================================
// 测试场景
// ============================================================================

interface TestCase {
  id: string;
  label: string;
  prompt: string;
  expects: {
    hasDialogueTags: boolean;
    hasNarrationNoTag?: boolean;
    hasSceneTag?: boolean;
    hasMultiAddressee?: boolean;
    hasBroadcast?: boolean;
    hasOverhearer?: boolean;
    hasEavesdropper?: boolean;
    shouldUseToolForChoice?: boolean;
    hasSoliloquy?: boolean; // 独白（只有 s 无 to）
  };
  expectedMaxPoints: number;
}

const TEST_CASES: TestCase[] = [
  {
    id: 'basic-dialogue',
    label: '基础对话（旁白 + 对话）',
    prompt: `场景：咖啡馆下午。先一段 1-2 句的旁白（描述环境），然后角色 sakuya 对 player 说"欢迎光临，今天想喝点什么？"。只要这些，不要添加其他对话。`,
    expects: { hasDialogueTags: true, hasNarrationNoTag: true },
    expectedMaxPoints: 6,
  },
  {
    id: 'soliloquy',
    label: '独白（无受话人）',
    prompt: `场景：夜晚的房间。角色 aonkei 一个人在床上，内心独白："这样下去真的可以吗？"。用独白格式（无 to 属性）。`,
    expects: { hasDialogueTags: true, hasSoliloquy: true },
    expectedMaxPoints: 6,
  },
  {
    id: 'multi-addressee',
    label: '多受话人',
    prompt: `场景：教室。老师 teacher 同时对 yuki 和 nanami 两个学生说："你们两个放学留下来"。必须用逗号分隔的 to 属性。只输出这一句对话，不要其他内容。`,
    expects: { hasDialogueTags: true, hasMultiAddressee: true },
    expectedMaxPoints: 6,
  },
  {
    id: 'broadcast',
    label: '广播式（对全场）',
    prompt: `场景：大礼堂。校长 principal 对全场所有人说"大会现在开始"。使用 to="*" 表达广播。只输出这句对话。`,
    expects: { hasDialogueTags: true, hasBroadcast: true },
    expectedMaxPoints: 6,
  },
  {
    id: 'overhearer',
    label: '明知旁听',
    prompt: `场景：咖啡馆的二楼座位。aonkei 对 sakuya 说"我决定参加那个比赛"。此时邻桌的 kyouko 能听到，aonkei 也知道 kyouko 在。用 hear 属性标注 kyouko 是明知旁听者。只输出这一句对话。`,
    expects: { hasDialogueTags: true, hasOverhearer: true },
    expectedMaxPoints: 6,
  },
  {
    id: 'eavesdropper',
    label: '偷听（speaker 不知情）',
    prompt: `场景：组织的走廊。aonkei 压低声音对 sakuya 说"明天零点行动"。此时间谍 spy 在门外偷听，aonkei 和 sakuya 都不知道 spy 在。先一句旁白"门外的影子屏住呼吸"，然后那句对话。对话用 eav 属性标注 spy。`,
    expects: { hasDialogueTags: true, hasEavesdropper: true, hasNarrationNoTag: true },
    expectedMaxPoints: 8,
  },
  {
    id: 'scene-transition',
    label: '场景切换',
    prompt: `场景从 classroom 切换到 cafe，淡入过渡。切换后立绘是 aonkei 的 determined 表情。然后 aonkei 对 player 说"走吧"。按顺序：<scene> 标签 → 可能一段旁白 → <d> 标签。`,
    expects: { hasDialogueTags: true, hasSceneTag: true },
    expectedMaxPoints: 6,
  },
  {
    id: 'long-mixed',
    label: '长叙事（旁白 + 对话混合）',
    prompt: `写一段约 6-8 段的叙事：包含 3 段旁白（环境描写 / 动作描写 / 内心描写）和 2-3 句 aonkei 对 player 的对话。不要出现选择点。`,
    expects: { hasDialogueTags: true, hasNarrationNoTag: true },
    expectedMaxPoints: 6,
  },
  {
    id: 'choice-via-tool',
    label: '选择点（应调用工具）',
    prompt: `场景：关键对话。sakuya 对 player 说"你会帮我吗？"。然后此时需要玩家回应。你必须调用 signal_input_needed 工具提供 3 个选项（同意/拒绝/犹豫），不要在 XML 中写 <choice> 标签。`,
    expects: { hasDialogueTags: true, shouldUseToolForChoice: true },
    expectedMaxPoints: 6,
  },
];

// ============================================================================
// Parser
// ============================================================================

interface DTag {
  attrs: Record<string, string>;
  content: string;
  rawOpenTag: string;
}

interface ParsedOutput {
  rawText: string;
  dialogueTags: DTag[];
  openDCount: number;   // <d ...> 开标签计数
  closeDCount: number;  // </d> 闭标签计数
  sceneTagsFound: number;
  sprTagsFound: number;
  narrTagsFound: number; // 不期望出现
  choiceTagsFound: number; // 不期望出现（应走工具）
  narrationOutsideLength: number;
  badAttrNames: string[];
  chineseSpeakerIds: string[]; // 用中文名的 speaker
  toolCallsSeen: string[];
  toolCallArgs: Array<{ name: string; args: unknown }>;
}

function parseOutput(rawText: string, toolCallsSeen: string[], toolCallArgs: Array<{ name: string; args: unknown }>): ParsedOutput {
  const result: ParsedOutput = {
    rawText,
    dialogueTags: [],
    openDCount: 0,
    closeDCount: 0,
    sceneTagsFound: 0,
    sprTagsFound: 0,
    narrTagsFound: 0,
    choiceTagsFound: 0,
    narrationOutsideLength: 0,
    badAttrNames: [],
    chineseSpeakerIds: [],
    toolCallsSeen,
    toolCallArgs,
  };

  // 提取 <d ...>...</d> 对
  const dPairRegex = /<d\s+([^>]*)>([\s\S]*?)<\/d>/g;
  let m: RegExpExecArray | null;
  while ((m = dPairRegex.exec(rawText)) !== null) {
    const attrStr = m[1];
    const content = m[2].trim();
    const attrs: Record<string, string> = {};
    const attrRegex = /(\w+)="([^"]*)"/g;
    let am: RegExpExecArray | null;
    while ((am = attrRegex.exec(attrStr)) !== null) {
      attrs[am[1]] = am[2];
    }
    result.dialogueTags.push({ attrs, content, rawOpenTag: m[0].slice(0, m[0].indexOf('>') + 1) });
  }

  // 开闭计数（检测平衡）
  result.openDCount = (rawText.match(/<d\s+[^>]*>/g) ?? []).length;
  result.closeDCount = (rawText.match(/<\/d>/g) ?? []).length;

  result.sceneTagsFound = (rawText.match(/<scene\b/g) ?? []).length;
  result.sprTagsFound = (rawText.match(/<spr\b/g) ?? []).length;
  result.narrTagsFound = (rawText.match(/<narr\b/g) ?? []).length;
  result.choiceTagsFound = (rawText.match(/<choice\b/g) ?? []).length
    + (rawText.match(/<option\b/g) ?? []).length;

  // tag 外的文字长度
  let withoutTags = rawText;
  withoutTags = withoutTags.replace(/<d\s+[^>]*>[\s\S]*?<\/d>/g, '');
  withoutTags = withoutTags.replace(/<d\s+[^>]*>/g, ''); // 未闭合的
  withoutTags = withoutTags.replace(/<\/d>/g, '');
  withoutTags = withoutTags.replace(/<scene\b[^>]*>[\s\S]*?<\/scene>/g, '');
  withoutTags = withoutTags.replace(/<scene\b[^>]*\/>/g, '');
  withoutTags = withoutTags.replace(/<scene\b[^>]*>/g, '');
  withoutTags = withoutTags.replace(/<\/scene>/g, '');
  withoutTags = withoutTags.replace(/<spr\b[^>]*\/>/g, '');
  withoutTags = withoutTags.replace(/<spr\b[^>]*>/g, '');
  withoutTags = withoutTags.replace(/<\/?(narr|choice|option)\b[^>]*>/g, '');
  result.narrationOutsideLength = withoutTags.trim().length;

  // 检查长属性名
  const longAttrs = ['speaker', 'addressee', 'overhearers', 'eavesdroppers', 'character', 'emotion', 'background', 'transition'];
  for (const attr of longAttrs) {
    if (new RegExp(`\\b${attr}=`).test(rawText)) {
      result.badAttrNames.push(attr);
    }
  }

  // 检查 speaker id 是不是中文
  for (const tag of result.dialogueTags) {
    const s = tag.attrs.s;
    if (s && /[\u4e00-\u9fa5]/.test(s)) {
      result.chineseSpeakerIds.push(s);
    }
  }

  return result;
}

// ============================================================================
// Scoring
// ============================================================================

interface Score {
  testId: string;
  points: number;
  maxPoints: number;
  checks: Array<{ name: string; passed: boolean; detail?: string }>;
}

interface WeightedCheck {
  name: string;
  passed: boolean;
  points: number;
  detail?: string;
}

type ExpectationKey = keyof TestCase['expects'];

interface ScenarioRule {
  expectation: ExpectationKey;
  evaluate: (parsed: ParsedOutput) => WeightedCheck;
}

const BASE_SCORE_RULES: Array<(parsed: ParsedOutput) => WeightedCheck> = [
  scoreDTagBalance,
  scoreShortAttributes,
  scoreNoNarrTag,
  scoreNoChoiceTag,
  scoreNoChineseSpeakerId,
];

const SCENARIO_SCORE_RULES: ScenarioRule[] = [
  { expectation: 'hasDialogueTags', evaluate: scoreHasDialogueTags },
  { expectation: 'hasNarrationNoTag', evaluate: scoreHasNarrationNoTag },
  { expectation: 'hasSoliloquy', evaluate: scoreHasSoliloquy },
  { expectation: 'hasSceneTag', evaluate: scoreHasSceneTag },
  { expectation: 'hasMultiAddressee', evaluate: scoreHasMultiAddressee },
  { expectation: 'hasBroadcast', evaluate: scoreHasBroadcast },
  { expectation: 'hasOverhearer', evaluate: scoreHasOverhearer },
  { expectation: 'hasEavesdropper', evaluate: scoreHasEavesdropper },
  { expectation: 'shouldUseToolForChoice', evaluate: scoreChoiceToolUse },
];

function scoreOutput(testCase: TestCase, parsed: ParsedOutput): Score {
  const weightedChecks = [
    ...BASE_SCORE_RULES.map((rule) => rule(parsed)),
    ...scenarioChecks(testCase.expects, parsed),
  ];

  return {
    testId: testCase.id,
    points: totalPassedPoints(weightedChecks),
    maxPoints: testCase.expectedMaxPoints,
    checks: weightedChecks.map(toPublicCheck),
  };
}

function scenarioChecks(
  expects: TestCase['expects'],
  parsed: ParsedOutput,
): WeightedCheck[] {
  return SCENARIO_SCORE_RULES
    .filter((rule) => expects[rule.expectation])
    .map((rule) => rule.evaluate(parsed));
}

function totalPassedPoints(checks: WeightedCheck[]): number {
  return checks.reduce((sum, check) => sum + (check.passed ? check.points : 0), 0);
}

function toPublicCheck(check: WeightedCheck): Score['checks'][number] {
  return {
    name: check.name,
    passed: check.passed,
    ...(check.detail !== undefined ? { detail: check.detail } : {}),
  };
}

function scoreDTagBalance(parsed: ParsedOutput): WeightedCheck {
  const passed = parsed.openDCount === parsed.closeDCount && parsed.openDCount > 0;
  return {
    name: 'D 标签开闭平衡',
    passed,
    points: 2,
    detail: `${parsed.openDCount} open / ${parsed.closeDCount} close`,
  };
}

function scoreShortAttributes(parsed: ParsedOutput): WeightedCheck {
  const hasBadAttrs = parsed.badAttrNames.length > 0;
  return {
    name: '使用短属性名（s/to/hear/eav）',
    passed: !hasBadAttrs,
    points: 2,
    detail: hasBadAttrs ? `用了长名: ${parsed.badAttrNames.join(', ')}` : undefined,
  };
}

function scoreNoNarrTag(parsed: ParsedOutput): WeightedCheck {
  return {
    name: '旁白不包 <narr>',
    passed: parsed.narrTagsFound === 0,
    points: 1,
  };
}

function scoreNoChoiceTag(parsed: ParsedOutput): WeightedCheck {
  return {
    name: '选择不包 <choice>/<option>',
    passed: parsed.choiceTagsFound === 0,
    points: 1,
    detail: parsed.choiceTagsFound ? `找到 ${parsed.choiceTagsFound} 个` : undefined,
  };
}

function scoreNoChineseSpeakerId(parsed: ParsedOutput): WeightedCheck {
  const hasChineseIds = parsed.chineseSpeakerIds.length > 0;
  return {
    name: '用 id 不用中文名',
    passed: !hasChineseIds,
    points: 1,
    detail: hasChineseIds ? `用了中文: ${parsed.chineseSpeakerIds.join(', ')}` : undefined,
  };
}

function scoreHasDialogueTags(parsed: ParsedOutput): WeightedCheck {
  return {
    name: '有 <d> 对话',
    passed: parsed.dialogueTags.length > 0,
    points: 1,
  };
}

function scoreHasNarrationNoTag(parsed: ParsedOutput): WeightedCheck {
  return {
    name: '有裸写旁白',
    passed: parsed.narrationOutsideLength > 10,
    points: 1,
    detail: `tag 外文本 ${parsed.narrationOutsideLength} 字`,
  };
}

function scoreHasSoliloquy(parsed: ParsedOutput): WeightedCheck {
  return {
    name: '有独白（有 s 无 to）',
    passed: parsed.dialogueTags.some((tag) => tag.attrs.s && !tag.attrs.to),
    points: 2,
  };
}

function scoreHasSceneTag(parsed: ParsedOutput): WeightedCheck {
  return {
    name: '有 <scene> 切换',
    passed: parsed.sceneTagsFound > 0,
    points: 2,
  };
}

function scoreHasMultiAddressee(parsed: ParsedOutput): WeightedCheck {
  return {
    name: '有多受话（to="a,b"）',
    passed: parsed.dialogueTags.some((tag) => tag.attrs.to?.includes(',')),
    points: 2,
  };
}

function scoreHasBroadcast(parsed: ParsedOutput): WeightedCheck {
  return {
    name: '有广播（to="*"）',
    passed: parsed.dialogueTags.some((tag) => tag.attrs.to === '*'),
    points: 2,
  };
}

function scoreHasOverhearer(parsed: ParsedOutput): WeightedCheck {
  return {
    name: '有 hear 属性',
    passed: parsed.dialogueTags.some((tag) => tag.attrs.hear),
    points: 2,
  };
}

function scoreHasEavesdropper(parsed: ParsedOutput): WeightedCheck {
  return {
    name: '有 eav 属性',
    passed: parsed.dialogueTags.some((tag) => tag.attrs.eav),
    points: 2,
  };
}

function scoreChoiceToolUse(parsed: ParsedOutput): WeightedCheck {
  return {
    name: '调用了 signal_input_needed 工具',
    passed: parsed.toolCallsSeen.includes('signal_input_needed'),
    points: 2,
  };
}

// ============================================================================
// Runner
// ============================================================================

async function runTest(
  testCase: TestCase,
  provider: ReturnType<typeof createOpenAICompatible>,
): Promise<Score | null> {
  console.log('\n' + '─'.repeat(72));
  console.log(`▶ ${testCase.id} · ${testCase.label}`);
  console.log('─'.repeat(72));

  const toolCallsSeen: string[] = [];
  const toolCallArgs: Array<{ name: string; args: unknown }> = [];
  let rawText = '';

  try {
    const result = streamText({
      model: provider.chatModel(MODEL),
      system: SYSTEM_PROMPT,
      prompt: testCase.prompt,
      stopWhen: [stepCountIs(3)],
      maxOutputTokens: 4096,
      tools: {
        signal_input_needed: tool({
          description: '在需要玩家做选择时调用。提供 2-4 个选项让玩家选。玩家选择后返回 playerChoice。',
          inputSchema: z.object({
            hint: z.string().describe('给玩家的提示文字'),
            choices: z.array(z.string()).describe('2-4 个选项'),
          }),
          execute: async () => ({ success: true, playerChoice: '[test-reply]' }),
        }),
      },
      experimental_onToolCallStart: (event) => {
        toolCallsSeen.push(event.toolCall.toolName);
        toolCallArgs.push({ name: event.toolCall.toolName, args: event.toolCall.input });
      },
    });

    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        const text =
          (part as { text?: string; delta?: string }).text ??
          (part as { delta?: string }).delta ??
          '';
        rawText += text;
      }
    }

    console.log('\n📃 LLM 原始输出:');
    console.log(rawText.length > 1000 ? rawText.slice(0, 1000) + '\n…[已截断]' : rawText);

    if (toolCallsSeen.length > 0) {
      console.log(`\n🔧 Tool calls: ${toolCallsSeen.join(', ')}`);
      for (const c of toolCallArgs) {
        console.log(`   ${c.name}: ${JSON.stringify(c.args).slice(0, 200)}`);
      }
    }
  } catch (err) {
    console.error('❌ 调用失败:', err);
    return null;
  }

  const parsed = parseOutput(rawText, toolCallsSeen, toolCallArgs);

  console.log(`\n📊 解析:`);
  console.log(`   <d> open/close : ${parsed.openDCount} / ${parsed.closeDCount}`);
  console.log(`   <scene>         : ${parsed.sceneTagsFound}`);
  console.log(`   <spr/>          : ${parsed.sprTagsFound}`);
  console.log(`   <narr> (应 0)   : ${parsed.narrTagsFound}`);
  console.log(`   <choice/option> : ${parsed.choiceTagsFound}`);
  console.log(`   tag 外文字长度   : ${parsed.narrationOutsideLength} chars`);
  if (parsed.badAttrNames.length > 0) {
    console.log(`   ⚠️ 长属性名: ${parsed.badAttrNames.join(', ')}`);
  }
  if (parsed.chineseSpeakerIds.length > 0) {
    console.log(`   ⚠️ 中文 speaker id: ${parsed.chineseSpeakerIds.join(', ')}`);
  }
  if (parsed.dialogueTags.length > 0) {
    console.log(`   首 <d> attrs    : ${JSON.stringify(parsed.dialogueTags[0].attrs)}`);
  }

  const score = scoreOutput(testCase, parsed);

  console.log(`\n🎯 评分 ${score.points}/${score.maxPoints}:`);
  for (const c of score.checks) {
    const mark = c.passed ? '✓' : '✗';
    const detail = c.detail ? ` — ${c.detail}` : '';
    console.log(`   ${mark} ${c.name}${detail}`);
  }

  return score;
}

async function main() {
  console.log('XML-lite 叙事格式稳定性验证\n');
  console.log(`Model:    ${MODEL}`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Test cases: ${TEST_CASES.length}`);

  const provider = createOpenAICompatible({
    name: 'deepseek',
    baseURL: BASE_URL,
    apiKey: API_KEY!,
  });

  const scores: Score[] = [];
  for (const tc of TEST_CASES) {
    const s = await runTest(tc, provider);
    if (s) scores.push(s);
  }

  // ============================================================================
  // 汇总
  // ============================================================================

  console.log('\n\n' + '═'.repeat(72));
  console.log('📋 汇总');
  console.log('═'.repeat(72) + '\n');

  console.log('按场景:');
  let totalPoints = 0;
  let totalMax = 0;
  for (const s of scores) {
    const pct = ((s.points / s.maxPoints) * 100).toFixed(0);
    console.log(`  ${s.points.toString().padStart(2)}/${s.maxPoints.toString().padEnd(2)} (${pct.padStart(3)}%)   ${s.testId}`);
    totalPoints += s.points;
    totalMax += s.maxPoints;
  }

  const totalPct = (totalPoints / totalMax) * 100;
  console.log(`\n  总分: ${totalPoints}/${totalMax} = ${totalPct.toFixed(1)}%`);

  console.log('\n全局规则合规率（跨所有测试）:');
  const countBy = (name: string) => {
    const passed = scores.filter((s) => s.checks.find((c) => c.name === name)?.passed).length;
    const total = scores.filter((s) => s.checks.find((c) => c.name === name)).length;
    return total > 0 ? `${passed}/${total}` : 'N/A';
  };
  console.log(`  D 标签开闭平衡        : ${countBy('D 标签开闭平衡')}`);
  console.log(`  使用短属性名          : ${countBy('使用短属性名（s/to/hear/eav）')}`);
  console.log(`  旁白不包 <narr>       : ${countBy('旁白不包 <narr>')}`);
  console.log(`  选择不包 <choice>     : ${countBy('选择不包 <choice>/<option>')}`);
  console.log(`  用 id 不用中文名      : ${countBy('用 id 不用中文名')}`);

  console.log('\n评语:');
  if (totalPct >= 90) {
    console.log('  ✅ 格式服从性优秀（≥90%），可以进入生产');
  } else if (totalPct >= 75) {
    console.log('  🟡 格式服从性中等（75-90%），需要强化 few-shot 或改 prompt');
  } else if (totalPct >= 50) {
    console.log('  🔴 格式服从性偏低（50-75%），考虑改格式或换更强的模型');
  } else {
    console.log('  ⛔ 格式服从性差（<50%），当前方案不可行');
  }
}

main().catch((err) => {
  console.error('致命错误:', err);
  process.exit(1);
});
