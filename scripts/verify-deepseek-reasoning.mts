#!/usr/bin/env bun
/**
 * verify-deepseek-reasoning.mts
 *
 * 用引擎里 `LLMClient.getModel()` 的**完全相同的组装方式**直接打 DeepSeek 的
 * /chat/completions，验证 V4 thinking 模式（含 tool calling）能不能正常调起来。
 *
 * 引擎里的 composition（packages/core/src/llm-client.mts:256-290）：
 *   createOpenAICompatible({
 *     name, baseURL, apiKey,
 *     transformRequestBody: thinkingEnabled !== null/undefined
 *       ? body => ({ ...body, thinking: { type: 'enabled' | 'disabled' } })
 *       : undefined,
 *   })
 *   provider.chatModel(model)
 *
 * + streamText({ ..., providerOptions: { openaiCompatible: { reasoningEffort } } })
 *
 * 用法（从 worktree 根目录；deps 走 root pnpm install 的 hoist）：
 *   pnpm install
 *   pnpm setup:env  # 把 ~/.config/ivn-editor/.env 软链到 apps/server/.env
 *   bun --env-file=apps/server/.env scripts/verify-deepseek-reasoning.mts
 *
 * 可覆写的环境变量（默认走 apps/server/.env 的 LLM_* 变量）：
 *   LLM_API_KEY     必填
 *   LLM_BASE_URL    默认 https://api.deepseek.com/v1
 *   LLM_MODEL       默认走 .env 的 LLM_MODEL；要测 V4 思考可临时
 *                   `LLM_MODEL=deepseek-reasoner bun ...` 覆写
 *
 * 输出：每个 case 打印
 *   - stream part 类型计数（重点看有没有 reasoning-delta）
 *   - reasoning_content / text 累计长度
 *   - finishReason + usage
 *   - 失败时打印完整 error
 */

import { streamText, stepCountIs, hasToolCall, tool, zodSchema, type ModelMessage } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { z } from 'zod/v4';

const API_KEY = process.env.LLM_API_KEY ?? process.env.DEEPSEEK_API_KEY;
const BASE_URL = process.env.LLM_BASE_URL ?? 'https://api.deepseek.com/v1';
const MODEL = process.env.LLM_MODEL ?? 'deepseek-reasoner';

if (!API_KEY) {
  console.error('❌ 需要 LLM_API_KEY (或 DEEPSEEK_API_KEY) 环境变量');
  console.error('   提示：bun --env-file apps/server/.env run scripts/verify-deepseek-reasoning.mts');
  process.exit(1);
}

console.log(`Base URL: ${BASE_URL}`);
console.log(`Model:    ${MODEL}`);

// ── 完全照搬引擎 getModel() 的组装方式 ─────────────────────────────────────────

function buildProvider(thinkingEnabled: boolean | null) {
  return createOpenAICompatible({
    name: 'deepseek',
    baseURL: BASE_URL,
    apiKey: API_KEY!,
    transformRequestBody:
      thinkingEnabled !== null
        ? (body) => ({
            ...body,
            thinking: { type: thinkingEnabled ? 'enabled' : 'disabled' },
          })
        : undefined,
  });
}

function buildProviderOptions(reasoningEffort: 'high' | 'max' | null) {
  return reasoningEffort !== null
    ? { openaiCompatible: { reasoningEffort } }
    : undefined;
}

// ── tools：模拟引擎里的 signal_input_needed + 一个简单业务工具 ────────────────

const aiTools = {
  get_weather: tool({
    description: '查询某个城市的当前天气',
    inputSchema: zodSchema(
      z.object({
        city: z.string().describe('城市名，例如 北京'),
      }),
    ),
    execute: async ({ city }) => {
      // 假数据
      return { city, temperature: 18, condition: '晴' };
    },
  }),
};

// ── 跑一个 case ───────────────────────────────────────────────────────────────

interface Case {
  label: string;
  thinkingEnabled: boolean | null;
  reasoningEffort: 'high' | 'max' | null;
  withTools: boolean;
  /** 二选一：单轮 prompt 或预制的多轮 messages 数组 */
  prompt?: string;
  messages?: ModelMessage[];
  /** 期望失败（负向对照），用于让脚本不在错误时退出 1 */
  expectFailure?: boolean;
}

async function runCase(c: Case) {
  console.log('\n' + '='.repeat(72));
  console.log(`▶ ${c.label}`);
  console.log(
    `  thinkingEnabled=${c.thinkingEnabled} reasoningEffort=${c.reasoningEffort} withTools=${c.withTools}` +
      (c.expectFailure ? ' [expect FAIL]' : ''),
  );
  console.log('='.repeat(72));

  const provider = buildProvider(c.thinkingEnabled);
  const providerOptions = buildProviderOptions(c.reasoningEffort);

  const partCounters: Record<string, number> = {};
  let fullText = '';
  let fullReasoning = '';
  let toolCallSeen = '';
  const t0 = Date.now();

  try {
    const result = streamText({
      model: provider.chatModel(MODEL),
      system: '你是一个助手。如果用户问天气，调用 get_weather 工具。',
      ...(c.messages ? { messages: c.messages } : { prompt: c.prompt! }),
      tools: c.withTools ? aiTools : undefined,
      stopWhen: c.withTools
        ? [stepCountIs(3), hasToolCall('get_weather')]
        : [stepCountIs(3)],
      maxOutputTokens: 1024,
      ...(providerOptions ? { providerOptions } : {}),
    });

    for await (const part of result.fullStream) {
      partCounters[part.type] = (partCounters[part.type] ?? 0) + 1;
      if (part.type === 'text-delta') {
        fullText += (part as { text?: string }).text ?? '';
      } else if (part.type === 'reasoning-delta') {
        fullReasoning += (part as { text?: string }).text ?? '';
      } else if (part.type === 'tool-call') {
        const tc = part as { toolName?: string; input?: unknown };
        toolCallSeen = `${tc.toolName ?? '?'}(${JSON.stringify(tc.input)})`;
      }
    }

    const finishReason = String(await result.finishReason);
    const usage = await result.usage;
    const elapsed = Date.now() - t0;

    console.log(`\n⏱  ${elapsed}ms`);
    console.log(`📊 stream parts:`);
    for (const [t, n] of Object.entries(partCounters).sort()) {
      console.log(`   ${t.padEnd(25)} ${n}`);
    }
    console.log(`📝 reasoning len=${fullReasoning.length}, text len=${fullText.length}`);
    if (toolCallSeen) console.log(`🔧 tool-call: ${toolCallSeen}`);
    console.log(`🏁 finish=${finishReason}, tokens in=${usage?.inputTokens ?? '?'} out=${usage?.outputTokens ?? '?'}`);

    if (fullReasoning) {
      console.log(`\n💭 reasoning 前 200:\n   ${fullReasoning.slice(0, 200).replace(/\n/g, '\\n')}`);
    }
    if (fullText) {
      console.log(`\n📃 text 前 200:\n   ${fullText.slice(0, 200).replace(/\n/g, '\\n')}`);
    }
  } catch (err) {
    const elapsed = Date.now() - t0;
    console.error(`\n❌ ${elapsed}ms FAILED`);
    if (err instanceof Error) {
      console.error(`   name: ${err.name}`);
      console.error(`   message: ${err.message}`);
      // AI SDK 的错误把 provider 原始 body 塞在 .responseBody / .data
      const detail =
        (err as unknown as { responseBody?: string }).responseBody ??
        (err as unknown as { data?: unknown }).data;
      if (detail) console.error(`   detail: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
    } else {
      console.error(err);
    }
  }
}

const PROMPT = '帮我查一下北京今天的天气。';

await runCase({
  label: 'case 1: thinking=null, no reasoningEffort, no tools (基线)',
  thinkingEnabled: null,
  reasoningEffort: null,
  withTools: false,
  prompt: '小明有 17 个苹果，给小红 5 个，又摘了 3 个，吃了 2 个。还剩几个？',
});

await runCase({
  label: 'case 2: thinking=enabled, reasoningEffort=high, no tools',
  thinkingEnabled: true,
  reasoningEffort: 'high',
  withTools: false,
  prompt: '小明有 17 个苹果，给小红 5 个，又摘了 3 个，吃了 2 个。还剩几个？',
});

await runCase({
  label: 'case 3: thinking=enabled, reasoningEffort=high, WITH tools (V4 docs 工具调用场景)',
  thinkingEnabled: true,
  reasoningEffort: 'high',
  withTools: true,
  prompt: PROMPT,
});

await runCase({
  label: 'case 4: thinking=disabled, no tools (escape hatch)',
  thinkingEnabled: false,
  reasoningEffort: null,
  withTools: false,
  prompt: '一句话介绍北京',
});

// ── case 5/6：复现 E2E 里那个 tool-only step replay 的 400 ─────────────────────
//
// 模拟 messages-builder 重组出来的历史：第一回合 LLM 调了 get_weather（tool-only
// step），玩家发了第二条 user message 后再发起 generate。两组 case 唯一区别：
//   case 5（负向对照）：assistant 消息只有 [ToolCallPart]，没 reasoning_content
//                       → 期望 DeepSeek 400（这就是当前 game-session 丢 reasoning
//                       后重组出来的形状）
//   case 6（正向）    ：assistant 消息是 [ReasoningPart, ToolCallPart]，带回 stub
//                       reasoning → 期望 DeepSeek 200，能继续生成
//
// 这两组 case 不动 schema、不改任何代码，只是手动构造 ModelMessages 喂 streamText，
// 用来验证"如果游戏 session 在 tool-only step 上能补出 reasoning，DeepSeek 就接受"
// 这条假设。case 6 通过 → 选项 B（schema 上加列存 step reasoning 或写 stub
// narrative entry）就值得迁移。

const TOOL_CALL_ID = 'call_replay_test_1';

const replayBaseMessages: ModelMessage[] = [
  { role: 'user', content: '帮我查北京天气。' },
  // —— 这里是关键：assistant 历史消息 ——
  // case 5/6 各自插入不同形状（在下面分别构造）
];

// V4 thinking 规则比"tool_calls 上必须带 reasoning_content"更严格：**两个 user 消息**
// 之间只要发生过 tool_call，中间所有 assistant 消息（包括纯文字收尾的那条）都得带
// reasoning_content 回传。所以 replayTail 的最终 assistant 文字消息也要带 reasoning。
const replayTail: ModelMessage[] = [
  {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: TOOL_CALL_ID,
        toolName: 'get_weather',
        output: { type: 'json', value: { city: '北京', temperature: 18, condition: '晴' } },
      },
    ],
  },
  {
    role: 'assistant',
    content: [
      {
        type: 'reasoning',
        text: '工具返回了北京天气数据，整理成自然语言回复。',
      },
      { type: 'text', text: '北京今天 18 度，晴。' },
    ],
  },
  { role: 'user', content: '上海呢？' },
];

// 错误对照：tail 里的 assistant 收尾不带 reasoning（即使前面 tool-call assistant
// 带了），DeepSeek 也会 400。把它单独起一份用于 case 7。
const replayTailNoReasoningOnFinalAssistant: ModelMessage[] = [
  replayTail[0]!, // tool-result
  { role: 'assistant', content: '北京今天 18 度，晴。' }, // 缺 reasoning
  { role: 'user', content: '上海呢？' },
];

const assistantToolOnlyNoReasoning: ModelMessage = {
  role: 'assistant',
  content: [
    {
      type: 'tool-call',
      toolCallId: TOOL_CALL_ID,
      toolName: 'get_weather',
      input: { city: '北京' },
    },
  ],
};

const assistantToolWithReasoning: ModelMessage = {
  role: 'assistant',
  content: [
    {
      type: 'reasoning',
      text: '用户问北京天气，我应该调用 get_weather 工具，参数 city="北京"。',
    },
    {
      type: 'tool-call',
      toolCallId: TOOL_CALL_ID,
      toolName: 'get_weather',
      input: { city: '北京' },
    },
  ],
};

await runCase({
  label: 'case 5: replay tool-only assistant WITHOUT reasoning_content (现状，期望 400)',
  thinkingEnabled: true,
  reasoningEffort: 'high',
  withTools: true,
  expectFailure: true,
  messages: [...replayBaseMessages, assistantToolOnlyNoReasoning, ...replayTail],
});

await runCase({
  label: 'case 6: replay tool-only + final-narrative 都带 reasoning_content (选项 B 形状，期望 200)',
  thinkingEnabled: true,
  reasoningEffort: 'high',
  withTools: true,
  messages: [...replayBaseMessages, assistantToolWithReasoning, ...replayTail],
});

await runCase({
  label: 'case 7: tool-call assistant 带 reasoning，但 final-narrative 不带 (期望 400 验证规则严格)',
  thinkingEnabled: true,
  reasoningEffort: 'high',
  withTools: true,
  expectFailure: true,
  messages: [
    ...replayBaseMessages,
    assistantToolWithReasoning,
    ...replayTailNoReasoningOnFinalAssistant,
  ],
});

console.log('\n' + '='.repeat(72));
console.log('done');
