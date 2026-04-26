/**
 * Bug Report Routes — 玩家 bug 反馈 HTTP 接口（PFB.3）
 *
 * 单一 POST 入口。required identity = registered 或 admin（拒匿名）。
 * 跟 routes/feedback.mts 平行设计；都走 requireNonAnonymous。
 */

import { Elysia } from 'elysia';
import { z } from 'zod/v4';
import { bugReportService } from '#internal/services/bug-report-service';
import { requireNonAnonymous, isResponse } from '#internal/auth-identity';

const DESCRIPTION_MAX_LEN = 5000;

const bugReportInputSchema = z.object({
  playthroughId: z.string().min(1).nullish(),
  /** 客户端 useGameStore.turn 的快照；非负整数。null 接受（玩家未启动游戏） */
  turn: z.number().int().min(0).nullish(),
  description: z.string().trim().min(1).max(DESCRIPTION_MAX_LEN),
});

export const bugReportRoutes = new Elysia({ prefix: '/api/bug-reports' })

  // POST / — 提交一份 bug 反馈
  .post('/', async ({ body, request }) => {
    const id = await requireNonAnonymous(request);
    if (isResponse(id)) return id;

    const parsed = bugReportInputSchema.safeParse(body);
    if (!parsed.success) {
      return new Response(
        JSON.stringify({ error: 'Invalid bug report payload', issues: parsed.error.issues }),
        { status: 400 },
      );
    }
    const input = parsed.data;

    if (input.playthroughId) {
      const ok = await bugReportService.playthroughBelongsToUser(input.playthroughId, id.userId);
      if (!ok) {
        return new Response(
          JSON.stringify({ error: 'playthroughId not found or not owned by current user' }),
          { status: 404 },
        );
      }
    }

    const result = await bugReportService.create({
      userId: id.userId,
      playthroughId: input.playthroughId ?? null,
      turn: input.turn ?? null,
      description: input.description.trim(),
    });
    return result;
  });
