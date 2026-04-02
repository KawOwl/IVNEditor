/**
 * LLM Config Store — 后端 LLM 配置的可变存储
 *
 * 启动时从环境变量加载默认值，编剧可通过 API 动态更新。
 * 更新后立即生效（新会话使用新配置）。
 * 持久化到 JSON 文件，重启后自动恢复。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

// ============================================================================
// Types
// ============================================================================

export interface ServerLLMConfig {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  name?: string;
}

// ============================================================================
// Store
// ============================================================================

const DATA_FILE = join(import.meta.dir, '../../data/llm-config.json');

/** 从环境变量读取初始值 */
function loadFromEnv(): ServerLLMConfig {
  return {
    provider: process.env.LLM_PROVIDER ?? 'openai-compatible',
    baseUrl: process.env.LLM_BASE_URL ?? 'https://api.deepseek.com/v1',
    apiKey: process.env.LLM_API_KEY ?? '',
    model: process.env.LLM_MODEL ?? 'deepseek-chat',
    name: process.env.LLM_NAME ?? 'server-llm',
  };
}

/** 从持久化文件读取（如果存在） */
function loadFromFile(): ServerLLMConfig | null {
  try {
    if (existsSync(DATA_FILE)) {
      const raw = readFileSync(DATA_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch {
    // ignore
  }
  return null;
}

/** 持久化到文件 */
function saveToFile(config: ServerLLMConfig) {
  try {
    const dir = dirname(DATA_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(DATA_FILE, JSON.stringify(config, null, 2));
  } catch (err) {
    console.error('Failed to persist LLM config:', err);
  }
}

// 初始化：优先从文件恢复，否则从环境变量
let currentConfig: ServerLLMConfig = loadFromFile() ?? loadFromEnv();

// ============================================================================
// Public API
// ============================================================================

/** 获取当前 LLM 配置（新会话创建时调用） */
export function getLLMConfig(): ServerLLMConfig {
  return { ...currentConfig };
}

/** 获取安全版本（不含 API Key，用于前端拉取） */
export function getLLMConfigSafe(): Omit<ServerLLMConfig, 'apiKey'> & { apiKey: string } {
  return {
    ...currentConfig,
    // 掩码 API key：只显示前 6 和后 4 位
    apiKey: maskApiKey(currentConfig.apiKey),
  };
}

/** 更新 LLM 配置（编剧推送时调用），立即生效 */
export function updateLLMConfig(patch: Partial<ServerLLMConfig>) {
  currentConfig = { ...currentConfig, ...patch };
  saveToFile(currentConfig);
  console.log(`🔧 LLM config updated: provider=${currentConfig.provider}, model=${currentConfig.model}`);
}

/** 重置为环境变量默认值 */
export function resetLLMConfig() {
  currentConfig = loadFromEnv();
  saveToFile(currentConfig);
  console.log('🔧 LLM config reset to env defaults');
}

// ============================================================================
// Helpers
// ============================================================================

function maskApiKey(key: string): string {
  if (!key || key.length < 12) return key ? '***' : '';
  return key.slice(0, 6) + '...' + key.slice(-4);
}
