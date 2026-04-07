/**
 * PlaythroughPersistence — SessionPersistence 的 DB 实现
 *
 * 将 GameSession coreLoop 的关键状态转换持久化到 PostgreSQL。
 * 通过 PlaythroughService 操作数据库，不直接访问 db/schema。
 */

import type { SessionPersistence } from '../../../src/core/game-session';
import { playthroughService } from './playthrough-service';

/**
 * 为指定 playthrough 创建 SessionPersistence 实现
 */
export function createPlaythroughPersistence(playthroughId: string): SessionPersistence {
  return {
    async onGenerateStart(turn: number): Promise<void> {
      await playthroughService.updateState(playthroughId, {
        status: 'generating',
        turn,
      });
    },

    async onGenerateComplete(data): Promise<void> {
      // 保存叙事条目
      if (data.entry.content) {
        await playthroughService.appendNarrativeEntry({
          playthroughId,
          role: data.entry.role,
          content: data.entry.content,
          reasoning: data.entry.reasoning,
          toolCalls: data.entry.toolCalls,
          finishReason: data.entry.finishReason,
        });
      }

      // 更新 memory 快照 + preview
      const preview = data.entry.content
        ? data.entry.content.slice(0, 80).replace(/\n/g, ' ')
        : null;

      await playthroughService.updateState(playthroughId, {
        memoryEntries: data.memoryEntries,
        memorySummaries: data.memorySummaries,
        preview,
      });
    },

    async onWaitingInput(data): Promise<void> {
      await playthroughService.updateState(playthroughId, {
        status: 'waiting-input',
        inputHint: data.hint,
        inputType: data.inputType,
        choices: data.choices,
      });
    },

    async onReceiveComplete(data): Promise<void> {
      // 保存玩家输入条目
      await playthroughService.appendNarrativeEntry({
        playthroughId,
        role: data.entry.role,
        content: data.entry.content,
      });

      // 更新状态 + memory
      await playthroughService.updateState(playthroughId, {
        stateVars: data.stateVars,
        turn: data.turn,
        memoryEntries: data.memoryEntries,
        memorySummaries: data.memorySummaries,
        // 清理输入状态
        inputHint: null,
        inputType: 'freetext',
        choices: null,
      });
    },
  };
}
