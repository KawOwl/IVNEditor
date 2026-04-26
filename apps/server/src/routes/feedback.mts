/**
 * Feedback Routes — 玩家问卷反馈 HTTP 接口（PFB.1）
 *
 * 单一 POST 入口，接收 5 题问卷答案落 `feedback` 表。
 * 任何已认证身份（含匿名 session）都能提交。
 *
 * 选项原文（中文）作为 enum 常量同时定义在这里和前端，后端用 zod 严格校验
 * 防止前端漂移把脏数据写进 DB。题目改文案时**前后端常量必须同步发布**。
 */

import { Elysia } from 'elysia';
import { z } from 'zod/v4';
import { feedbackService } from '#internal/services/feedback-service';
import { requireNonAnonymous, isResponse } from '#internal/auth-identity';

const Q4_OTHER = '其他' as const;

const Q1_OPTIONS = [
  '橙光/易次元等互动小说',
  '底特律变人、隐形守护者等单机剧情游戏',
  '线下剧本杀 / 跑团（TRPG） / 语C聊天',
  '基本只看纯文本的网文/传统小说',
] as const;

const Q2_OPTIONS = [
  '角色像鱼的记忆，前面的选择后面全忘了',
  '剧情逻辑崩坏，角色强行降智',
  '选项全是假的，选什么最后结局都一样',
  '必须自己动脑子做选择，感觉太累了',
] as const;

const Q3_OPTIONS = [
  '给我一个输入框自由打字，AI真的能懂我的意思并接上剧情',
  '生成的剧情文本质量很高，逻辑严密不降智',
  '既有现成的选项，关键时候也能自己打字，两不误',
] as const;

const Q4_OPTIONS = [
  '购买体力/次数：为了能继续和AI对话或开启新剧情',
  '购买"后悔药"：为了回溯剧情，修改之前选错的决定',
  '解锁内容：为了看隐藏结局、番外或精美角色立绘',
  '尚未付费过，通常只体验免费部分',
  Q4_OTHER,
] as const;

const Q5_OPTIONS = [
  '仅辅助生成选项文案',
  '生成次要支线/NPC的实时互动',
  '生成主线关键剧情',
  '完全不接受AI，纯人工创作最好',
] as const;

const Q4_OTHER_MAX_LEN = 500;

const feedbackInputSchema = z.object({
  playthroughId: z.string().min(1).nullish(),
  q1: z.enum(Q1_OPTIONS),
  q2: z.enum(Q2_OPTIONS),
  q3: z.enum(Q3_OPTIONS),
  q4: z.enum(Q4_OPTIONS),
  q4Other: z.string().trim().min(1).max(Q4_OTHER_MAX_LEN).nullish(),
  q5: z.enum(Q5_OPTIONS),
});

export const feedbackRoutes = new Elysia({ prefix: '/api/feedback' })

  // POST / — 提交一份问卷
  .post('/', async ({ body, request }) => {
    const id = await requireNonAnonymous(request);
    if (isResponse(id)) return id;

    const parsed = feedbackInputSchema.safeParse(body);
    if (!parsed.success) {
      return new Response(
        JSON.stringify({ error: 'Invalid feedback payload', issues: parsed.error.issues }),
        { status: 400 },
      );
    }
    const input = parsed.data;

    // q4 = '其他' 时 q4Other 必填；其他选项时必须不传或为 null
    if (input.q4 === Q4_OTHER) {
      if (!input.q4Other) {
        return new Response(
          JSON.stringify({ error: 'q4Other is required when q4 is "其他"' }),
          { status: 400 },
        );
      }
    } else if (input.q4Other) {
      return new Response(
        JSON.stringify({ error: 'q4Other must be null when q4 is not "其他"' }),
        { status: 400 },
      );
    }

    // 拒绝伪造的 playthroughId（防止用别人的 id 污染他人记录）
    if (input.playthroughId) {
      const ok = await feedbackService.playthroughBelongsToUser(input.playthroughId, id.userId);
      if (!ok) {
        return new Response(
          JSON.stringify({ error: 'playthroughId not found or not owned by current user' }),
          { status: 404 },
        );
      }
    }

    const result = await feedbackService.create({
      userId: id.userId,
      playthroughId: input.playthroughId ?? null,
      q1: input.q1,
      q2: input.q2,
      q3: input.q3,
      q4: input.q4,
      q4Other: input.q4 === Q4_OTHER ? (input.q4Other ?? null) : null,
      q5: input.q5,
    });
    return result;
  });

// 公开选项常量给前端复用
export const FEEDBACK_OPTIONS = {
  q1: Q1_OPTIONS,
  q2: Q2_OPTIONS,
  q3: Q3_OPTIONS,
  q4: Q4_OPTIONS,
  q5: Q5_OPTIONS,
  q4Other: Q4_OTHER,
} as const;
