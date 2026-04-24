/**
 * Seed M3 咖啡馆测试剧本
 *
 * 用于验证 M3 视觉层（XML-lite 叙事协议 + SceneState + 视觉工具）端到端流程。
 *
 * 行为：
 *   - 找到 role='admin' 的第一个 user 作为作者
 *   - upsert scripts 行（固定 id 方便复用）
 *   - 生成一个完整 ScriptManifest，塞进 script_versions 并直接 publish
 *
 * Manifest 要点：
 *   - backgrounds: cafe_interior / cafe_window
 *   - characters: sakuya（smile / serious / sad 三表情）
 *   - defaultScene: cafe_interior 无立绘
 *   - enabledTools: 基础 + change_scene/change_sprite/clear_stage
 *   - systemPrompt（作为 content segment）提示 LLM：用对话+旁白推进，
 *     关键节点调 change_scene / change_sprite
 *
 * 运行：
 *   cd apps/server && bun run scripts/seed-m3-cafe.ts
 */

import { eq } from 'drizzle-orm';
import { db, schema } from '#internal/db';
import { scriptService } from '#internal/services/script-service';
import { scriptVersionService } from '#internal/services/script-version-service';
import type { ScriptManifest } from '@ivn/core/types';

const SCRIPT_ID = 'm3-cafe-test';

function buildManifest(): ScriptManifest {
  const systemPromptContent = `你是一个 VN（视觉小说）风格的 Game Master。

剧本背景：
  玩家角色"我"（无立绘）坐在一家安静的咖啡馆窗边位置。一位叫 sakuya
  的女性朋友已经到达，坐在对面。窗外是下午四点的街景。

角色与资产：
  - 玩家：身份"我"（不出现立绘），使用 id "player" 作为 participation frame
    里的 speaker/addressee。
  - sakuya：id "sakuya"，立绘表情有 smile / serious / sad 三种，可用位置
    left / center / right。
  - 背景：cafe_interior（咖啡馆内景，sakuya 在场时的默认背景）、
    cafe_window（窗外街景，用于气氛切换）。

推进规则：
  - 开局第一轮：调用 change_scene 把背景切到 cafe_interior，sakuya
    以 smile 表情出现在 center 位置，随后用 1~2 段旁白 + 1~2 句 sakuya 的
    对话进入正题。
  - sakuya 的表情要随情绪变化自然调整：轻松 → smile；谈论工作/严肃话题
    → serious；被触及难过往事 → sad。每次情绪切换调 change_sprite。
  - 气氛切换（比如镜头看窗外、回忆）可以用 change_scene 切到
    cafe_window，结束回忆再切回 cafe_interior。
  - 每轮用 signal_input_needed 给玩家 2–4 个选择继续故事。
  - 如果玩家想结束对话，调 end_scenario。
  - **调 change_scene 时同步调 update_state({current_scene: ...})**：
    背景切到 cafe_interior → state.current_scene = "cafe_interior"
    背景切到 cafe_window → state.current_scene = "cafe_window"
    保持 VN 视觉和 state 变量一致（Focus Injection 依赖这个同步）。

叙事格式（必须严格遵守）：
  - 旁白 = 裸文本，一行一段。
  - 对话必须用 <d s="角色id" to="对方id">正文</d> 包裹。
    玩家回 sakuya：<d s="player" to="sakuya">...</d>
    sakuya 对玩家：<d s="sakuya" to="player">...</d>
  - 独白/内心（对方不在场或不对任何人说）：<d s="sakuya">...</d>（省略 to）。
  - 不要输出任何解释性元文本（如"（以下对话）""好的"）。`;

  return {
    id: SCRIPT_ID,
    label: '咖啡馆测试 M3',
    description: '用于验证 M3 视觉层的最小剧本：咖啡馆窗边和 sakuya 聊天，验证 change_scene / change_sprite / XML-lite 对话标签 + PF 能端到端跑通。',
    author: 'admin',
    tags: ['测试', 'M3', 'VN', '视觉层'],
    openingMessages: [
      '—— 下午四点的咖啡馆，靠窗的位置。',
      '你提前到了，刚坐下不久，sakuya 推开门走进来。',
    ],
    stateSchema: {
      variables: [
        { name: 'mood', type: 'string', initial: 'relaxed', description: 'sakuya 当前情绪：relaxed / serious / sad' },
        { name: 'turn', type: 'number', initial: 0, description: '对话轮数' },
        { name: 'current_scene', type: 'string', initial: 'cafe_interior', description: '当前场景 id（供 Focus Injection 推断）：cafe_interior / cafe_window' },
      ],
    },
    memoryConfig: {
      contextBudget: 60000,
      compressionThreshold: 50000,
      recencyWindow: 30,
    },
    enabledTools: [
      'read_state',
      'update_state',
      'pin_memory',
      'query_memory',
      'change_scene',
      'change_sprite',
      'clear_stage',
      'signal_input_needed',
      'end_scenario',
    ],
    initialPrompt: '开始。第一轮请务必先调用 change_scene 渲染出 cafe_interior 背景 + sakuya(smile) 立绘，然后用旁白 + sakuya 的一句开场白推进。',
    characters: [
      {
        id: 'sakuya',
        displayName: '咲夜',
        sprites: [
          { id: 'smile', label: '微笑' },
          { id: 'serious', label: '认真' },
          { id: 'sad', label: '伤感' },
        ],
      },
    ],
    backgrounds: [
      { id: 'cafe_interior', label: '咖啡馆内景' },
      { id: 'cafe_window', label: '窗外街景' },
    ],
    defaultScene: {
      background: 'cafe_interior',
      sprites: [],
    },
    chapters: [
      {
        id: 'ch1',
        label: '第一章：约在咖啡馆',
        flowGraph: {
          id: 'ch1-flow',
          label: '第一章流程',
          nodes: [
            { id: 'opening', label: '入场', description: '背景 + sakuya 出场', promptSegments: ['system-gm'] },
          ],
          edges: [],
        },
        segments: [
          {
            id: 'system-gm',
            label: 'GM 指令（system）',
            content: systemPromptContent,
            contentHash: '',
            type: 'content',
            sourceDoc: 'inline',
            role: 'system',
            priority: 1,
            tokenCount: Math.ceil(systemPromptContent.length / 2),
          },
          // Focus Injection demo：两段带 scene tag 的 supplement，
          // 运行时按 state.current_scene 匹配到的那段会出现在 _engine_scene_context
          // section 的 "Most relevant segments" 列表里。
          {
            id: 'seg-scene-cafe-interior',
            label: 'scene_cafe_interior',
            content: `\`\`\`
[咖啡馆内景细节 — 仅 cafe_interior 场景]
- 窗边木桌有一盆小绿植
- 吧台方向传来磨豆机间歇的响声
- sakuya 手边的拿铁杯上漂着心形拉花
- 背景乐是 Norah Jones 的 Don't Know Why
\`\`\`
描写对话时适合加入这些细节让场景立体。`,
            contentHash: '',
            type: 'content',
            sourceDoc: 'scene_cafe_interior.md',
            role: 'context',
            priority: 5,
            focusTags: { scene: 'cafe_interior' },
            tokenCount: 120,
          },
          {
            id: 'seg-scene-cafe-window',
            label: 'scene_cafe_window',
            content: `\`\`\`
[窗外街景细节 — 仅 cafe_window 场景]
- 街灯是暖黄色老式铸铁路灯
- 对面是一家面包店，傍晚六点开始打折
- 一只橘猫经常从咖啡馆门口慢悠悠走过
- 偶尔有骑单车的上班族按铃
\`\`\`
切到这个场景时用这些元素烘托傍晚温暖氛围。`,
            contentHash: '',
            type: 'content',
            sourceDoc: 'scene_cafe_window.md',
            role: 'context',
            priority: 5,
            focusTags: { scene: 'cafe_window' },
            tokenCount: 110,
          },
        ],
      },
    ],
  };
}

async function main() {
  // 1. 找 admin 用户
  const adminRows = await db
    .select({ id: schema.users.id, username: schema.users.username })
    .from(schema.users)
    .where(eq(schema.users.roleId, 'admin'))
    .limit(1);

  if (adminRows.length === 0) {
    console.error('[seed-m3-cafe] 找不到 admin 用户，先跑 seed-admin.ts');
    process.exit(1);
  }
  const admin = adminRows[0]!;
  console.log(`[seed-m3-cafe] author = ${admin.username} (${admin.id})`);

  // 2. upsert script 身份
  const manifest = buildManifest();
  const script = await scriptService.create({
    id: manifest.id,
    authorUserId: admin.id,
    label: manifest.label,
    description: manifest.description,
  });
  console.log(`[seed-m3-cafe] script upsert: ${script.id} "${script.label}"`);

  // 3. 发布新版本（直接 published，这样玩家首页就能看到）
  const result = await scriptVersionService.create({
    scriptId: script.id,
    manifest,
    status: 'published',
    label: 'v1 seed',
    note: '通过 seed-m3-cafe.ts 创建',
  });
  if (result.created) {
    console.log(`[seed-m3-cafe] 新版本 v${result.version.versionNumber} published (id=${result.version.id})`);
  } else {
    console.log(`[seed-m3-cafe] 内容 hash 未变，复用 v${result.version.versionNumber} (status=${result.version.status})`);
  }

  console.log('[seed-m3-cafe] 完成。浏览器打开 http://localhost:5174/ 看剧本卡。');
  process.exit(0);
}

main().catch((err) => {
  console.error('[seed-m3-cafe] 致命错误:', err);
  process.exit(1);
});
