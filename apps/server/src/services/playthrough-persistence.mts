/**
 * PlaythroughPersistence — SessionPersistence 的 DB 实现
 *
 * 将 GameSession coreLoop 的关键状态转换持久化到 PostgreSQL。
 * 通过 PlaythroughService 操作数据库，不直接访问 db/schema。
 */

import type { SessionPersistence } from '@ivn/core/game-session';
import { playthroughService } from '#internal/services/playthrough-service';

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
     * generate() 整体结束后同步 memory 快照 + VN 场景（M3）
     */
    async onGenerateComplete(data): Promise<void> {
      await playthroughService.updateState(playthroughId, {
        memorySnapshot: data.memorySnapshot,
        ...(data.preview !== undefined ? { preview: data.preview } : {}),
        ...(data.currentScene !== undefined ? { currentScene: data.currentScene } : {}),
      });
    },

    async onWaitingInput(data): Promise<void> {
      const patch: Record<string, unknown> = {
        status: 'waiting-input',
        inputHint: data.hint,
        inputType: data.inputType,
        choices: data.choices,
      };
      // signal 路径会带 memorySnapshot —— 断线重连后 memory 不空
      if (data.memorySnapshot) patch.memorySnapshot = data.memorySnapshot;
      // signal 路径还带 currentScene —— onGenerateComplete 在这个路径下不会触发
      // （generate() 挂起未返回），所以这里得兜底写 DB，否则重连后舞台是黑的
      if (data.currentScene !== undefined) patch.currentScene = data.currentScene;
      // 2026-04-24：state 变量快照。避免 LLM 本轮 update_state 改动的 state
      // （比如 chapter 切换）滞后一个回合才入库（原来只在 onReceiveComplete
      // 写 stateVars，下次 restore state 和 history 不一致）
      if (data.stateVars !== undefined) patch.stateVars = data.stateVars;
      await playthroughService.updateState(playthroughId, patch);
    },

    async onReceiveComplete(data): Promise<void> {
      await playthroughService.updateState(playthroughId, {
        status: 'idle',
        stateVars: data.stateVars,
        turn: data.turn,
        memorySnapshot: data.memorySnapshot,
        // 清理输入状态
        inputHint: null,
        inputType: 'freetext',
        choices: null,
      });
    },

    async onScenarioFinished(data): Promise<void> {
      // LLM 调了 end_scenario：把 playthrough 标为 finished 状态。
      // 之后 sessions.ts 恢复该 playthrough 时直接不启动 coreLoop，
      // 前端据 status='finished' 显示只读终局。
      //
      // reason 暂时不单独建字段存储，附加到 preview 里供编剧/玩家看一眼。
      const patch: Record<string, unknown> = {
        status: 'finished',
        // 清理输入状态（进 finished 就不该再有 hint/choices 了）
        inputHint: null,
        inputType: 'freetext',
        choices: null,
      };
      if (data.reason) {
        patch.preview = `[完] ${data.reason.slice(0, 76)}`;
      }
      await playthroughService.updateState(playthroughId, patch);
    },
  };
}
