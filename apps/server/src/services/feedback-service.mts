/**
 * FeedbackService — 玩家问卷反馈业务逻辑层（PFB.1）
 *
 * 5 题问卷直接落 `feedback` 表。校验由 route 层处理（zod 风格 enum 校验），
 * service 层只做 insert + 简单 ownership lookup。
 */

import { eq } from 'drizzle-orm';
import { db, schema } from '#internal/db';

export interface CreateFeedbackInput {
  /** 提交人 user.id */
  userId: string;
  /** 当前 playthrough id（可空：玩家在没启动游戏时也允许反馈） */
  playthroughId: string | null;
  q1: string;
  q2: string;
  q3: string;
  q4: string;
  /** q4 = '其他' 时的自填内容；其他选项时必为 null */
  q4Other: string | null;
  q5: string;
}

export class FeedbackService {
  async create(input: CreateFeedbackInput): Promise<{ id: string }> {
    const id = crypto.randomUUID();
    await db.insert(schema.feedback).values({
      id,
      userId: input.userId,
      playthroughId: input.playthroughId,
      q1: input.q1,
      q2: input.q2,
      q3: input.q3,
      q4: input.q4,
      q4Other: input.q4Other,
      q5: input.q5,
    });
    return { id };
  }

  /**
   * 校验 playthrough 归属当前 user。返回 true 表示 playthrough 存在且归属该 user。
   * Route 层用此拒绝伪造 playthroughId 的请求。
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

export const feedbackService = new FeedbackService();
