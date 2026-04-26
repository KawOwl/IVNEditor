/**
 * BugReportService — 玩家 bug 反馈业务逻辑层（PFB.3）
 *
 * 跟 feedback-service 平行：薄 service，只 insert + 简单 ownership lookup。
 * 校验由 route 层 zod 处理。
 */

import { eq } from 'drizzle-orm';
import { db, schema } from '#internal/db';

export interface CreateBugReportInput {
  userId: string;
  playthroughId: string | null;
  /** 提交瞬间的 turn（client-side useGameStore.turn 来源；不做"playthroughId
   * 为 null 时清 turn"的转换，留作已知约定——分析时 join playthrough 即可定位） */
  turn: number | null;
  description: string;
}

export class BugReportService {
  async create(input: CreateBugReportInput): Promise<{ id: string }> {
    const id = crypto.randomUUID();
    await db.insert(schema.bugReports).values({
      id,
      userId: input.userId,
      playthroughId: input.playthroughId,
      turn: input.turn,
      description: input.description,
    });
    return { id };
  }

  /**
   * 校验 playthrough 归属当前 user。route 层用此拒绝伪造 playthroughId。
   * 跟 feedback-service.playthroughBelongsToUser 同模式。
   */
  async playthroughBelongsToUser(playthroughId: string, userId: string): Promise<boolean> {
    const rows = await db
      .select({ userId: schema.playthroughs.userId })
      .from(schema.playthroughs)
      .where(eq(schema.playthroughs.id, playthroughId))
      .limit(1);
    return rows[0]?.userId === userId;
  }
}

export const bugReportService = new BugReportService();
