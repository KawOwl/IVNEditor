import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import { LLMClient } from '@ivn/core/llm-client';
import { entryToLLMConfig, useLLMConfigsStore } from '@/stores/llm-configs-store';
import type { EditorDocument } from './editor-documents';

export interface RewriteProgress {
  segment: number;
  maxSegments: number;
}

export interface UseAIRewriteOptions {
  documents: EditorDocument[];
  setDocuments: Dispatch<SetStateAction<EditorDocument[]>>;
  playtestLlmConfigId: string | null;
}

const MAX_REWRITE_SEGMENTS = 8;

function createRewritePrompt(content: string): string {
  return `你是一位互动叙事引擎的 prompt 优化专家。你的任务是改写下面的 system prompt，使其更好地利用引擎提供的工具系统。

## 引擎提供的工具

1. **update_state(patch)** — 更新游戏状态变量（如：好感度、章节进度、物品库存等）
2. **signal_input_needed(prompt_hint, choices)** — 在叙事到达分支点时，向玩家提供 2-4 个可点击的选项按钮
3. **read_state(keys?)** — 读取当前状态变量
4. **query_changelog(filter)** — 查询状态变更历史
5. **pin_memory(content, tags?)** — 固定重要记忆（防止被压缩丢失）
6. **query_memory(query)** — 搜索历史记忆

## 改写要求

1. **不要改变原文的叙事风格、世界观设定和角色描述**
2. **在适当位置添加工具调用指引**，例如：
   - 在描述需要玩家做选择的情节时，提示使用 signal_input_needed
   - 在描述会影响数值/状态的情节时，提示使用 update_state
   - 在描述重要信息揭示时，提示使用 pin_memory
3. **直接写工具的裸名**（例如 read_state、update_state、signal_input_needed），
   不要加任何特殊符号或占位符。GM 会从 tool schema 识别这些名称。
4. **保持原文结构和段落划分**
5. **输出完整改写后的 prompt，不要输出解释或说明**

## 原始 Prompt

${content}

## 改写后的 Prompt（直接输出，不要加任何前缀说明）`;
}

function createRewriteMessages(rewritePrompt: string, accumulated: string, segment: number) {
  if (segment === 1) {
    return [{ role: 'user' as const, content: rewritePrompt }];
  }

  return [
    { role: 'user' as const, content: rewritePrompt },
    { role: 'assistant' as const, content: accumulated },
    {
      role: 'user' as const,
      content:
        '继续输出改写后 prompt 的剩余部分。直接从你上次停下的地方续写，不要重复已经输出过的内容，不要加任何前缀说明。',
    },
  ];
}

export function useAIRewrite({
  documents,
  setDocuments,
  playtestLlmConfigId,
}: UseAIRewriteOptions) {
  const [rewritingDocId, setRewritingDocId] = useState<string | null>(null);
  const [rewriteProgress, setRewriteProgress] = useState<RewriteProgress | null>(null);

  const rewriteDocument = useCallback(async (docId: string) => {
    const doc = documents.find((d) => d.id === docId);
    if (!doc || doc.role !== 'system') return;

    const configsState = useLLMConfigsStore.getState();
    const preferredId = playtestLlmConfigId ?? configsState.configs[0]?.id ?? null;
    const configEntry = configsState.getById(preferredId);
    if (!configEntry) {
      alert('请先在"设置"里创建至少一套 LLM 配置，或在"试玩使用 LLM"里选一套');
      return;
    }

    const client = new LLMClient(entryToLLMConfig(configEntry));
    const rewritePrompt = createRewritePrompt(doc.content);

    setRewritingDocId(docId);
    setRewriteProgress({ segment: 0, maxSegments: MAX_REWRITE_SEGMENTS });

    let accumulated = '';
    let reachedLimit = false;

    try {
      for (let seg = 1; seg <= MAX_REWRITE_SEGMENTS; seg++) {
        setRewriteProgress({ segment: seg, maxSegments: MAX_REWRITE_SEGMENTS });

        const result = await client.generate({
          systemPrompt:
            '你是 prompt 改写助手。只输出改写后的 prompt 全文，不要输出任何额外说明。',
          messages: createRewriteMessages(rewritePrompt, accumulated, seg),
          tools: {},
          maxOutputTokens: configEntry.maxOutputTokens ?? 8192,
        });

        if (!result.text) break;

        accumulated += result.text;

        setDocuments((prev) =>
          prev.map((d) =>
            d.id === docId
              ? { ...d, derivedContent: accumulated, useDerived: false }
              : d,
          ),
        );

        if (result.finishReason !== 'length') break;
        if (seg === MAX_REWRITE_SEGMENTS) reachedLimit = true;
      }

      if (reachedLimit) {
        alert(
          `AI 改写续写达到上限 ${MAX_REWRITE_SEGMENTS} 段仍未完成。\n` +
          '已保存累积结果，但内容可能仍被截断。建议手动补齐或拆分原文后重试。',
        );
      }
    } catch (err) {
      alert('AI 改写失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setRewritingDocId(null);
      setRewriteProgress(null);
    }
  }, [documents, playtestLlmConfigId, setDocuments]);

  return {
    rewritingDocId,
    rewriteProgress,
    rewriteDocument,
  };
}
