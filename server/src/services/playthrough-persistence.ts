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
        // kind 默认 'narrative'（onNarrativeSegmentFinalized 的语义就是常规叙事段）
        content: data.entry.content,
        reasoning: data.entry.reasoning,
        finishReason: data.entry.finishReason,
        batchId: data.batchId ?? null,
      });

      // 更新 preview 为最新的这段
      const preview = data.entry.content.slice(0, 80).replace(/\n/g, ' ');
      await playthroughService.updateState(playthroughId, { preview });
    },

    /**
     * generate() 整体结束后同步 memory 快照 + VN 场景（M3）
     * entry 入库已由 onNarrativeSegmentFinalized 负责
     */
    async onGenerateComplete(data): Promise<void> {
      await playthroughService.updateState(playthroughId, {
        memorySnapshot: data.memorySnapshot,
        ...(data.preview !== undefined ? { preview: data.preview } : {}),
        ...(data.currentScene !== undefined ? { currentScene: data.currentScene } : {}),
      });
    },

    /**
     * 把 signal_input_needed 一次调用写成一条 narrative_entry。
     * role='system' + kind='signal_input' + content=hint + payload={choices}。
     * 见 .claude/plans/conversation-persistence.md Step 2。
     */
    async onSignalInputRecorded(data): Promise<void> {
      await playthroughService.appendNarrativeEntry({
        playthroughId,
        role: 'system',
        kind: 'signal_input',
        content: data.hint,
        payload: { choices: data.choices },
        batchId: data.batchId ?? null,
      });
    },

    /**
     * 普通工具（update_state / change_scene 等）调用完成时触发，写成 kind='tool_call' 条目。
     * 见 .claude/plans/messages-model.md Step 5 & migration 0011。
     */
    async onToolCallRecorded(data): Promise<void> {
      await playthroughService.appendNarrativeEntry({
        playthroughId,
        role: 'system',
        kind: 'tool_call',
        content: data.toolName,
        payload: { input: data.input, output: data.output },
        batchId: data.batchId,
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
      // 保存玩家输入条目（migration 0010 / 0011）
      //   kind='player_input'，payload 带 inputType + selectedIndex（如果选了 choice）
      //   batchId 由 game-session 每次提交独立生成 —— 未来多模态一次提交多 entry 会复用
      await playthroughService.appendNarrativeEntry({
        playthroughId,
        role: data.entry.role,
        kind: 'player_input',
        content: data.entry.content,
        payload: data.payload as Record<string, unknown> | undefined,
        batchId: data.batchId ?? null,
      });

      // 更新状态 + memory
      await playthroughService.updateState(playthroughId, {
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
