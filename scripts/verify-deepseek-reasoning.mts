#!/usr/bin/env bun
/**
 * verify-deepseek-reasoning.mts
 *
 * 验证 DeepSeek 到底把"推理内容"放在哪里：
 *   (a) reasoning-delta 流事件（AI SDK 原生字段，正确）
 *   (b) text-delta 流事件里夹带（混进叙事 content，需要 ReasoningFilter 救）
 *   (c) 某种 provider 特有的扩展字段
 *
 * 用法：
 *   DEEPSEEK_API_KEY=sk-xxx bun run scripts/verify-deepseek-reasoning.mts
 *
 * 可选参数（环境变量）：
 *   DEEPSEEK_BASE_URL   默认 https://api.deepseek.com/v1
 *   DEEPSEEK_MODEL      默认 deepseek-chat（可改 deepseek-reasoner 对比）
 *   SKIP_THINKING_ON    跳过 enable_thinking=true 的一组
 *
 * 输出会对每种配置打印：
 *   - 每种 stream part type 的次数和前 80 字样本
 *   - reasoning 文本累积长度 vs text 累积长度
 *   - finishReason + token usage
 *   - 最后给一个判定：a/b/c 中哪种
 */

import { streamText, stepCountIs } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

// ============================================================================
// 配置
// ============================================================================

const API_KEY = process.env.DEEPSEEK_API_KEY;
const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1';
const MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat';
const SKIP_THINKING_ON = process.env.SKIP_THINKING_ON === '1';

if (!API_KEY) {
  console.error('❌ 需要 DEEPSEEK_API_KEY 环境变量');
  process.exit(1);
}

// 一个需要逻辑推理的 prompt，便于触发"思考过程"
const TEST_PROMPT = `小明有 17 个苹果，他给了小红 5 个，然后从树上摘了 3 个，接着吃掉了 2 个。请一步步推理，最后告诉我小明现在有几个苹果。`;

// ============================================================================
// 运行一个配置
// ============================================================================

interface TestConfig {
  label: string;
  enableThinking: boolean;
}

async function runCase(cfg: TestConfig) {
  console.log('\n' + '='.repeat(72));
  console.log(`▶ ${cfg.label}`);
  console.log(`  model=${MODEL}, enable_thinking=${cfg.enableThinking}`);
  console.log('='.repeat(72));

  const provider = createOpenAICompatible({
    name: 'deepseek',
    baseURL: BASE_URL,
    apiKey: API_KEY!,
    transformRequestBody: (body) => ({
      ...body,
      enable_thinking: cfg.enableThinking,
    }),
  });

  const partCounters: Record<string, number> = {};
  const firstSamples: Record<string, string> = {};
  let fullText = '';
  let fullReasoning = '';
  let finishReason = 'unknown';
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  const stepRecords: Array<{
    step: number;
    partKinds: string[];
    reasoningLen: number;
    textLen: number;
    finishReason: string;
  }> = [];

  const t0 = Date.now();

  try {
    const result = streamText({
      model: provider.chatModel(MODEL),
      system: '你是一个数学助手。',
      prompt: TEST_PROMPT,
      stopWhen: [stepCountIs(3)],
      maxOutputTokens: 800,
      onStepFinish: (step) => {
        const partKinds = Array.from(
          new Set(((step.content ?? []) as Array<{ type: string }>).map((p) => p.type)),
        );
        stepRecords.push({
          step: step.stepNumber,
          partKinds,
          reasoningLen: step.reasoningText?.length ?? 0,
          textLen: step.text?.length ?? 0,
          finishReason: String(step.finishReason),
        });
      },
    });

    // 遍历 fullStream，捕获每种 part 类型
    for await (const part of result.fullStream) {
      const type = part.type;
      partCounters[type] = (partCounters[type] ?? 0) + 1;

      // 第一次见到这个类型时存样本（前 80 字）
      if (!firstSamples[type]) {
        try {
          const s = JSON.stringify(part, (_k, v) =>
            typeof v === 'string' && v.length > 80 ? v.slice(0, 80) + '…' : v,
          );
          firstSamples[type] = s.length > 300 ? s.slice(0, 300) + '…' : s;
        } catch {
          firstSamples[type] = '[unserializable]';
        }
      }

      if (part.type === 'text-delta') {
        // AI SDK v6 的 text-delta part 结构
        const text = (part as { text?: string; delta?: string }).text ??
                     (part as { delta?: string }).delta ?? '';
        fullText += text;
      } else if (part.type === 'reasoning-delta') {
        const text = (part as { text?: string; delta?: string }).text ??
                     (part as { delta?: string }).delta ?? '';
        fullReasoning += text;
      }
    }

    finishReason = String(await result.finishReason);
    const usage = await result.usage;
    inputTokens = usage?.inputTokens;
    outputTokens = usage?.outputTokens;
  } catch (err) {
    console.error('❌ 调用失败:', err);
    return;
  }

  const elapsed = Date.now() - t0;

  // --- 输出 ---

  console.log(`\n⏱  总耗时: ${elapsed}ms`);
  console.log(`\n📊 Stream part 类型统计:`);
  for (const [type, count] of Object.entries(partCounters).sort()) {
    console.log(`   ${type.padEnd(25)} ${String(count).padStart(5)}`);
  }

  console.log(`\n🔍 各类型首个样本（截 300 字）:`);
  for (const [type, sample] of Object.entries(firstSamples).sort()) {
    console.log(`   [${type}]`);
    console.log(`     ${sample}`);
  }

  console.log(`\n📝 累计长度:`);
  console.log(`   fullText (text-delta 拼)       : ${fullText.length} chars`);
  console.log(`   fullReasoning (reasoning-delta): ${fullReasoning.length} chars`);

  console.log(`\n🏁 最终:`);
  console.log(`   finishReason: ${finishReason}`);
  console.log(`   tokens: input=${inputTokens ?? '?'} output=${outputTokens ?? '?'}`);

  console.log(`\n🧩 Step-level content parts (from onStepFinish):`);
  for (const r of stepRecords) {
    console.log(
      `   step ${r.step}: partKinds=[${r.partKinds.join(', ')}], ` +
      `textLen=${r.textLen}, reasoningLen=${r.reasoningLen}, finishReason=${r.finishReason}`,
    );
  }

  // --- text 和 reasoning 的前 200 字样本 ---

  if (fullText) {
    console.log(`\n📃 fullText 前 200 字:\n   ${fullText.slice(0, 200).replace(/\n/g, '\\n')}`);
  }
  if (fullReasoning) {
    console.log(`\n💭 fullReasoning 前 200 字:\n   ${fullReasoning.slice(0, 200).replace(/\n/g, '\\n')}`);
  }

  // --- 判定 ---

  console.log(`\n🎯 判定:`);
  const hasReasoningDelta = (partCounters['reasoning-delta'] ?? 0) > 0;
  const hasReasoningInText =
    !hasReasoningDelta &&
    fullText.length > 0 &&
    (fullText.includes('一步步') ||
      fullText.includes('首先') ||
      fullText.includes('推理') ||
      /\d+\s*[-+]\s*\d+/.test(fullText));

  if (hasReasoningDelta && fullReasoning.length > 0) {
    console.log('   ✅ (a) reasoning-delta 流事件 — AI SDK 原生分离，下游可直接用 onReasoningChunk');
  } else if (hasReasoningInText) {
    console.log('   ⚠️  (b) reasoning 混在 text-delta 里 — 需要 ReasoningFilter 类启发式分离');
  } else {
    console.log('   🔹 (c) 看起来 LLM 没输出显式推理（可能 prompt 不够引导，或模型非思考型）');
  }
}

// ============================================================================
// 入口
// ============================================================================

async function main() {
  console.log('DeepSeek reasoning 字段位置验证\n');
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Model:    ${MODEL}`);

  await runCase({
    label: '测试 1: enable_thinking=false (默认配置)',
    enableThinking: false,
  });

  if (!SKIP_THINKING_ON) {
    await runCase({
      label: '测试 2: enable_thinking=true',
      enableThinking: true,
    });
  }

  console.log('\n' + '='.repeat(72));
  console.log('✅ 完成');
  console.log('='.repeat(72));
  console.log('\n阅读要点:');
  console.log('  1. 看 "Stream part 类型统计" — 有没有 reasoning-delta 行');
  console.log('  2. 看 step-level partKinds — 有 "reasoning" 吗？还是只有 "text"？');
  console.log('  3. 对比两种 enable_thinking 设置的差异');
  console.log('  4. 看 fullText 内容 — 如果推理文字混在这里，说明 (b) 情况');
  console.log('');
  console.log('  对 deepseek-reasoner (R1) 跑一次:');
  console.log('    DEEPSEEK_MODEL=deepseek-reasoner DEEPSEEK_API_KEY=... \\');
  console.log('      bun run scripts/verify-deepseek-reasoning.mts');
}

main().catch((err) => {
  console.error('致命错误:', err);
  process.exit(1);
});
