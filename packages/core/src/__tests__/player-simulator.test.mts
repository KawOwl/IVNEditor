/**
 * PlayerSimulator · prompt builders + output sanitizer
 *
 * `decide` 本身的 LLM 调用走 live eval 验证；这里只测纯函数部分（prompt
 * 拼接 + 输出 sanitize）—— 这块的 bug 是静默的（LLM 还会输出东西，但 GM 端
 * 不会按预期分辨 choice / freetext），单测必须覆盖。
 */

import { describe, it, expect } from 'bun:test';
import {
  buildSimulatorSystemPrompt,
  buildTurnContextMessage,
  sanitizeSimulatorOutput,
} from '#internal/evaluation/player-simulator';

describe('buildSimulatorSystemPrompt', () => {
  it('inlines goal', () => {
    const prompt = buildSimulatorSystemPrompt({
      goal: '拿到银钥匙打开禁门',
      llmConfig: dummyLLMConfig,
    });
    expect(prompt).toContain('拿到银钥匙打开禁门');
    expect(prompt).toContain('【你的目标】');
  });

  it('omits style block when style is undefined', () => {
    const prompt = buildSimulatorSystemPrompt({
      goal: 'g',
      llmConfig: dummyLLMConfig,
    });
    expect(prompt).not.toContain('【你的说话风格】');
  });

  it('inlines style block when provided', () => {
    const prompt = buildSimulatorSystemPrompt({
      goal: 'g',
      style: '话不多',
      llmConfig: dummyLLMConfig,
    });
    expect(prompt).toContain('【你的说话风格】');
    expect(prompt).toContain('话不多');
  });

  it('mentions the 6 output rules to suppress meta talk', () => {
    const prompt = buildSimulatorSystemPrompt({ goal: 'g', llmConfig: dummyLLMConfig });
    // 抽查几条关键约束
    expect(prompt).toContain('逐字复述');
    expect(prompt).toContain('不要前缀');
    expect(prompt).toContain('不要 markdown');
    expect(prompt).toContain('不要说"作为 AI"');
  });
});

describe('buildTurnContextMessage', () => {
  it('numbers choices starting from 1', () => {
    const msg = buildTurnContextMessage({
      turn: 1,
      narration: 'Luna 把银钥匙递给你。',
      hint: '你想做什么？',
      choices: ['收下银钥匙', '拒绝', '转身离开'],
    });
    expect(msg).toContain('1. 收下银钥匙');
    expect(msg).toContain('2. 拒绝');
    expect(msg).toContain('3. 转身离开');
  });

  it('shows freetext placeholder when choices empty', () => {
    const msg = buildTurnContextMessage({
      turn: 1,
      narration: 'n',
      hint: 'h',
      choices: [],
    });
    expect(msg).toContain('（无，请自由输入）');
  });

  it('shows hint placeholder when hint is null', () => {
    const msg = buildTurnContextMessage({
      turn: 1,
      narration: 'n',
      hint: null,
      choices: ['a'],
    });
    expect(msg).toContain('【GM 提示】\n（无）');
  });

  it('preserves narration verbatim', () => {
    const narration = '夜色已深，<background id="library_hall"/>Luna 把一枚银钥匙递给你...';
    const msg = buildTurnContextMessage({ turn: 1, narration, hint: 'h', choices: [] });
    expect(msg).toContain(narration);
  });
});

describe('sanitizeSimulatorOutput', () => {
  it('trims surrounding whitespace', () => {
    expect(sanitizeSimulatorOutput('  收下银钥匙  ')).toBe('收下银钥匙');
  });

  it('strips ASCII double quotes', () => {
    expect(sanitizeSimulatorOutput('"收下银钥匙"')).toBe('收下银钥匙');
  });

  it('strips Chinese book quotes 「」', () => {
    expect(sanitizeSimulatorOutput('「收下银钥匙」')).toBe('收下银钥匙');
  });

  it('strips Chinese book quotes 『』', () => {
    expect(sanitizeSimulatorOutput('『收下银钥匙』')).toBe('收下银钥匙');
  });

  it('strips bold markdown', () => {
    expect(sanitizeSimulatorOutput('**收下银钥匙**')).toBe('收下银钥匙');
  });

  it('strips leading bullet', () => {
    expect(sanitizeSimulatorOutput('- 收下银钥匙')).toBe('收下银钥匙');
    expect(sanitizeSimulatorOutput('* 收下银钥匙')).toBe('收下银钥匙');
  });

  it('does NOT strip inner quotes / markdown that are part of intended content', () => {
    expect(sanitizeSimulatorOutput('我说"快走"，然后跑')).toBe('我说"快走"，然后跑');
  });

  it('returns empty string when input is whitespace only', () => {
    expect(sanitizeSimulatorOutput('   \n  ')).toBe('');
  });
});

const dummyLLMConfig = {
  provider: 'openai-compatible',
  baseURL: 'http://localhost:1',
  apiKey: 'dummy',
  model: 'dummy',
} as const;
