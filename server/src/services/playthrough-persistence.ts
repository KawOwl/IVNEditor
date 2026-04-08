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

    /**
     * 每段叙事 finalize 前调用（signal_input_needed 挂起前 / generate 返回后）
     * 每次调用都新增一条 narrative_entry 记录 + 更新 preview
     */
    async onNarrativeSegmentFinalized(data): Promise<void> {
      if (!data.entry.content) return;

      await playthroughService.appendNarrativeEntry({
        playthroughId,
        role: data.entry.role,
        content: data.entry.content,
        reasoning: data.entry.reasoning,
        toolCalls: data.entry.toolCalls,
        finishReason: data.entry.finishReason,
      });

      // 更新 preview 为最新的这段
      const preview = data.entry.content.slice(0, 80).replace(/\n/g, ' ');
      await playthroughService.updateState(playthroughId, { preview });
    },

    /**
     * generate() 整体结束后同步 memory 快照
     * entry 入库已由 onNarrativeSegmentFinalized 负责
     */
    async onGenerateComplete(data): Promise<void> {
      await playthroughService.updateState(playthroughId, {
        memoryEntries: data.memoryEntries,
        memorySummaries: data.memorySummaries,
        ...(data.preview !== undefined ? { preview: data.preview } : {}),
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
