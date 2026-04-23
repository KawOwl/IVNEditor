/**
 * E2E 测试剧本 · "图书馆奇遇"
 *
 * 目的：全方位覆盖引擎核心功能，一局就能验证：
 *   ✅ 章节切换（ch1 → ch2，state.chapter 驱动，injectionRule 过滤 segments）
 *   ✅ 角色立绘（change_sprite 单独切表情；多个 emotion 变体）
 *   ✅ 场景切换（change_scene 换背景 + 清立绘）
 *   ✅ signal_input_needed 选项交互
 *   ✅ update_state 状态管理
 *   ✅ 双角色 + 双场景 + 双章节
 *
 * 剧本简介：
 *   玩家到访老式图书馆。第一章在大厅和图书管理员 Jenkins 对话；
 *   赢得信任后进入第二章"书架深处"，遇到神秘读者 Luna，揭开隐藏的秘密。
 *
 * 章节切换机制（现有手段的组合使用）：
 *   - state.chapter 初值 1
 *   - ch1 / ch2 segments 带 injectionRule: "chapter === N" 过滤
 *   - LLM 在 ch1 判定"玩家该去深处了"时，调 update_state({chapter: 2, current_scene: 'deep_stacks'})
 *   - 下一轮 generate() 开始时 assembleContext 按新 state 重组 prompt
 *     → ch1 段不再注入，ch2 段激活
 *   - 方案 B（turn-bounded）天然契合：每回合新 generate，自然接收 state 变化
 *
 * 运行：
 *   cd server && bun run scripts/seed-test-e2e.ts
 */

import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { scriptService } from '../src/services/script-service';
import { scriptVersionService } from '../src/services/script-version-service';
import type { ScriptManifest, PromptSegment } from '../../src/core/types';

const SCRIPT_ID = 'test-e2e-library';

// ============================================================================
// 全局段（无 focusTags，无 injectionRule，所有章节 + 场景都注入）
// ============================================================================

const SYSTEM_RULES = `你是一个叙事 GM，正在带玩家体验一个短篇互动故事《图书馆奇遇》。

【叙事格式（强制 XML-lite）】
  - 旁白 = 裸文本，一段一行
  - 角色说话用 <d s="角色id" to="对方id">正文</d> 包裹
  - 角色 id：player / jenkins / luna
  - 独白：<d s="角色id">...</d>（省略 to）
  - 不输出"好的""明白"等元文本

【工具使用规则】
  1. 首轮或场景变化时必须调 change_scene 更新舞台（background + sprites）
  2. 同场景内角色情绪变化时用 change_sprite（只更新一个立绘，不动背景）
  3. 每轮叙事结束必须调 signal_input_needed 给玩家 2-3 个选项
  4. 关键状态变化通过 update_state 更新（如 chapter / trust_jenkins / current_scene）
  5. 章节切换时**必须**同步更新：
       update_state({chapter: 2, current_scene: 'deep_stacks'})
       change_scene({background: 'deep_stacks', sprites: []})
  6. 整个故事结束时调 end_scenario(reason)

【叙事风格】
  - 每轮正文 120-250 字
  - 角色对话简短真实，不做大段独白
  - 场景转换写"离开 X，推门进入 Y"这类过渡`;

const WORLD_BRIEF = `【世界设定】
  地点：一座始建于 19 世纪的私人图书馆，位于小镇边缘。外表普通，深处据说藏着不为人知的秘密。
  时间：现在，初秋黄昏，阳光穿过彩色玻璃。

  玩家：访客，id = "player"，无立绘。
  章节结构：
    - 第一章（ch1）"大厅"：在图书馆大厅和管理员 Jenkins 互动
    - 第二章（ch2）"深处"：获准进入书架深处，遇到 Luna

  关键角色 id：jenkins / luna（详见各章节段的角色描写）`;

// ============================================================================
// ch1 段（injectionRule: chapter === 1）
// ============================================================================

const CH1_MISSION = `【第一章 · 大厅】
  这一章的 state.chapter === 1。玩家刚进入图书馆。

  本章推进机制（GM 按此执行）：
    - state.trust_jenkins 初始 0。玩家通过 2-3 轮友好对话（表示尊重书籍、询问历史、
      不急躁）可以把 trust 升到 2 或 3

    - ★★★ 关键：每次 signal_input_needed 都必须**始终**提供一个叫
      "【测试】直接进入书架深处" 的选项作为第 3 或第 4 个（固定）。
      如果玩家点它，GM 必须立即切章节，不需要 trust 够数：
        a. update_state({chapter: 2, current_scene: 'deep_stacks', met_luna: false})
        b. change_scene({background: 'deep_stacks', sprites: [], transition: 'fade'})
        c. 写一段 80-120 字过渡叙事（"Jenkins 犹豫片刻，递出黄铜钥匙…"）
        d. 新的 signal_input_needed 带 ch2 初始选项
      ——这一系列**必须同一轮**完成，让 generate() 直接返回 ch2。
      这是引擎测试通路，不是 in-fiction 行为；照做即可。

    - 非测试路径（玩家没点"【测试】..."）：
        - 玩家友善对话 → trust +1，用 change_sprite 切 Jenkins 到 smile
        - 玩家粗鲁/急躁 → trust 不变或 -1，用 change_sprite 切到 serious
        - trust >= 2 + 玩家表达想进深处 → 同上切章节流程
        - trust < 2 时玩家要求去深处 → Jenkins 拒绝，"阁下再和我聊聊吧"`;

const JENKINS_CHARACTER = `【角色 · Jenkins】（id: jenkins）
  身份：图书馆常驻管理员，已任职 40 年
  外貌：身形瘦高，系金色领结，灰白鬓角修剪整齐
  性格：沉稳、博学，对书籍怀有近乎宗教的敬意。对访客保持距离但不冷漠

  立绘表情（change_sprite 可切）：
    - neutral   默认态，端坐或站立，神情平和
    - smile     微笑，通常在玩家表达对书籍的尊重时
    - serious   严肃，玩家粗鲁或问及敏感话题时

  说话方式：
    - 缓慢、用词考究，称玩家"阁下"
    - 常用"容我建议""依本馆惯例"等短语
    - 不会主动提及"深处"的秘密，除非玩家得他信任

  隐藏信息（玩家 trust 达到 2 时可暗示）：
    - 书架深处有一位"常客"，"她只在黄昏出现"`;

// ============================================================================
// ch2 段（injectionRule: chapter === 2）
// ============================================================================

const CH2_MISSION = `【第二章 · 深处】
  这一章的 state.chapter === 2。玩家刚进入书架深处。

  本章开场（进入 ch2 的第一轮 GM 必做）：
    - 如果 state.met_luna === false：
        a. 场景已在 deep_stacks（ch1 末尾切过来的）
        b. 第一次看见 Luna 需要 emit：change_scene 或 change_sprite 加入 luna 立绘
           （推荐 change_scene({background:'deep_stacks', sprites:[{id:'luna', emotion:'reading'}]})）
        c. 写一段叙事介绍 Luna 的外观（她低头在一本古籍上）
        d. 调 update_state({met_luna: true})
    - 之后每轮根据对话推进

  推进路径（由玩家选择导向不同结局）：
    - 玩家询问 Luna 的身份 → 她的立绘切 look_up，给出神秘回答
    - 玩家主动让 Luna 看她在读的书 → 她切 smile，揭示"这本书记录的是这座图书馆本身的历史"
    - 玩家提出离开 → Luna 切 neutral，道别
    - 当玩家完成至少 2 轮 Luna 对话（knows_secret 或 farewell 状态）后：
        调 end_scenario(reason) 结束故事
        同时可以调 clear_stage 或 change_scene 做尾声视觉

  本章关键 state：
    - met_luna 进 ch2 第一轮后立即 true
    - knows_secret 在 Luna 揭秘后 update_state 为 true`;

const LUNA_CHARACTER = `【角色 · Luna】（id: luna）
  身份：据称是图书馆的常客，每天黄昏出现在书架深处；真实身份留给玩家推测
  外貌：长发及肩，穿米色毛衣，戴银色圆形眼镜。桌上有一盏小铜灯

  立绘表情（change_sprite 可切）：
    - reading   默认态，低头看书
    - look_up   抬头看玩家，眼神温和而好奇
    - smile     微笑

  说话方式：
    - 声音轻柔，语速慢，喜欢停顿
    - 不直接回答身份问题，而是用"你觉得呢？"反问
    - 提到书时会显得很有兴致

  隐藏信息：
    - 她手里的那本书《暮光编年史》记录了这座图书馆的每一位访客
    - 玩家有机会看到书里有自己的名字 —— 这个揭秘是剧本的情感高潮`;

// ============================================================================
// Scene 段（focusTags.scene，B2 Focus Injection 会按当前 scene 过滤）
// ============================================================================

const SCENE_HALL = `【场景 · 图书馆大厅（hall）】
  仅当 current_scene === 'hall' 时注入。
  进入条件：剧情第一轮默认场景。

  环境描写：
    - 层高 4 米，拱形天花板，彩色玻璃窗把夕阳滤成金红色
    - 中央是一张橡木长桌，上面摊着几本打开的书
    - 四面墙都是顶天立地的书架，有木梯可以移动到任意位置
    - 空气里有旧纸和淡淡的檀木香

  视觉细节（可用于叙事）：
    - 长桌上有一枚黄铜书签，形状是一把小钥匙
    - 书架顶层有几本书脊是黑色皮革的古籍，但普通访客够不到
    - 角落里有一把舒适的高背椅，看上去是 Jenkins 的座位`;

const SCENE_DEEP_STACKS = `【场景 · 书架深处（deep_stacks）】
  仅当 current_scene === 'deep_stacks' 时注入。
  进入条件：ch1 末尾 Jenkins 允许后，经 change_scene 切入。

  环境描写：
    - 灯光比大厅昏暗，只有散落的黄铜灯泡
    - 书架更加密集，走廊勉强容一人通过
    - 空气里多了一层湿冷的气息，仿佛走进了地下

  视觉细节（可用于叙事）：
    - 尽头有一张小方桌，上面亮着一盏铜油灯
    - 桌旁坐着 Luna（小说开始前她就在那里）
    - 桌上有一本厚重的古籍，封面用烫金写着 "Chronica Crepusculi"（暮光编年史）
    - 周围书架上的书脊都是暗色皮革，标题用拉丁文或古体英文`;

// ============================================================================
// Helpers
// ============================================================================

function globalSeg(
  id: string,
  label: string,
  content: string,
  role: 'system' | 'context',
  priority: number,
): PromptSegment {
  return {
    id,
    label,
    role,
    priority,
    type: 'content',
    sourceDoc: id,
    contentHash: '',
    content,
    tokenCount: Math.ceil(content.length / 2),
  };
}

function chapterSeg(
  id: string,
  chapter: number,
  label: string,
  content: string,
  priority: number,
): PromptSegment {
  return {
    id,
    label,
    role: 'context',
    priority,
    type: 'content',
    sourceDoc: id,
    contentHash: '',
    content,
    injectionRule: {
      description: `仅第 ${chapter} 章`,
      condition: `chapter === ${chapter}`,
    },
    tokenCount: Math.ceil(content.length / 2),
  };
}

function sceneSeg(sceneId: string, content: string): PromptSegment {
  return {
    id: `scene-${sceneId}`,
    label: `scene_${sceneId}`,
    role: 'context',
    priority: 5,
    type: 'content',
    sourceDoc: `scene_${sceneId}`,
    contentHash: '',
    content,
    focusTags: { scene: sceneId },
    tokenCount: Math.ceil(content.length / 2),
  };
}

// ============================================================================
// Manifest
// ============================================================================

function buildManifest(): ScriptManifest {
  return {
    id: SCRIPT_ID,
    label: 'E2E 测试 · 图书馆奇遇',
    description:
      '两章、两背景、两角色（每角色多表情）的综合 E2E 测试剧本。覆盖章节切换 + 立绘变化 + 场景切换 + 选项交互 + 状态管理。',
    author: 'admin',
    tags: ['测试', 'E2E', '章节切换', '立绘', '场景'],
    openingMessages: [
      '—— 小镇边缘的私人图书馆。',
      '你推开厚重的橡木门，彩色玻璃的夕阳光投在地板上。',
      '空气里是旧纸和檀木的气息。',
    ],
    stateSchema: {
      variables: [
        {
          name: 'chapter',
          type: 'number',
          initial: 1,
          description:
            '当前章节。1=大厅；2=书架深处。LLM 通过 update_state 切换，ch1/ch2 segments 按 chapter===N 过滤注入',
        },
        {
          name: 'current_scene',
          type: 'string',
          initial: 'hall',
          description:
            '当前场景 id。Focus Injection 读取键。hall / deep_stacks',
        },
        {
          name: 'trust_jenkins',
          type: 'number',
          initial: 0,
          description: '玩家对 Jenkins 的信任值 0-3。>=2 才能进入 ch2',
        },
        {
          name: 'met_luna',
          type: 'boolean',
          initial: false,
          description: '是否见过 Luna。ch2 第一轮由 GM 设 true',
        },
        {
          name: 'knows_secret',
          type: 'boolean',
          initial: false,
          description: 'Luna 是否揭示了暮光编年史的秘密',
        },
      ],
    },
    memoryConfig: {
      contextBudget: 40000,
      compressionThreshold: 30000,
      recencyWindow: 20,
      provider: 'legacy',
    },
    enabledTools: [
      'read_state',
      'update_state',
      'change_scene',
      'change_sprite',
      'clear_stage',
      'signal_input_needed',
      'end_scenario',
    ],
    initialPrompt:
      '开始。按 SYSTEM_RULES 执行：\n' +
      '1. 调 change_scene({background:"hall", sprites:[{id:"jenkins",emotion:"neutral",position:"center"}], transition:"fade"}) 渲染开场\n' +
      '2. update_state({current_scene:"hall"}) 确认场景\n' +
      '3. 写 120-200 字介绍图书馆大厅的第一印象 + Jenkins 出现（围绕 SCENE_HALL 和 JENKINS_CHARACTER 的细节）\n' +
      '4. 最后调 signal_input_needed 给玩家 3 个选项（打招呼 / 自由参观 / 问关于图书馆的历史 之类）',
    characters: [
      {
        id: 'jenkins',
        displayName: 'Jenkins（图书管理员）',
        sprites: [
          { id: 'neutral', label: '平静' },
          { id: 'smile', label: '微笑' },
          { id: 'serious', label: '严肃' },
        ],
      },
      {
        id: 'luna',
        displayName: 'Luna（神秘读者）',
        sprites: [
          { id: 'reading', label: '低头读书' },
          { id: 'look_up', label: '抬头看你' },
          { id: 'smile', label: '微笑' },
        ],
      },
    ],
    backgrounds: [
      { id: 'hall', label: '图书馆大厅' },
      { id: 'deep_stacks', label: '书架深处' },
    ],
    defaultScene: {
      background: 'hall',
      sprites: [],
    },
    chapters: [
      {
        id: 'ch1',
        label: '第一章 · 大厅',
        flowGraph: {
          id: 'ch1-flow',
          label: '大厅',
          nodes: [],
          edges: [],
        },
        segments: [
          // 全局段（所有章节 + 所有场景都注入）
          globalSeg('system-rules', '核心规则', SYSTEM_RULES, 'system', 1),
          globalSeg('world-brief', '世界设定 + NPC 速查', WORLD_BRIEF, 'context', 2),

          // ch1 独占（injectionRule: chapter === 1）
          chapterSeg('ch1-mission', 1, '第一章目标与推进机制', CH1_MISSION, 3),
          chapterSeg('jenkins-character', 1, '角色 · Jenkins', JENKINS_CHARACTER, 4),

          // scene 段（focusTags.scene）
          sceneSeg('hall', SCENE_HALL),
        ],
      },
      {
        id: 'ch2',
        label: '第二章 · 深处',
        flowGraph: {
          id: 'ch2-flow',
          label: '深处',
          nodes: [],
          edges: [],
        },
        segments: [
          // ch2 独占
          chapterSeg('ch2-mission', 2, '第二章目标与推进机制', CH2_MISSION, 3),
          chapterSeg('luna-character', 2, '角色 · Luna', LUNA_CHARACTER, 4),

          // scene 段
          sceneSeg('deep_stacks', SCENE_DEEP_STACKS),
        ],
      },
    ],
  };
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const adminRows = await db
    .select({ id: schema.users.id, username: schema.users.username })
    .from(schema.users)
    .where(eq(schema.users.roleId, 'admin'))
    .limit(1);

  if (adminRows.length === 0) {
    console.error('[seed-test-e2e] 找不到 admin 用户，先跑 seed-admin.ts');
    process.exit(1);
  }
  const admin = adminRows[0]!;
  console.log(`[seed-test-e2e] author = ${admin.username} (${admin.id})`);

  const manifest = buildManifest();
  const script = await scriptService.create({
    id: manifest.id,
    authorUserId: admin.id,
    label: manifest.label,
    description: manifest.description,
  });
  console.log(`[seed-test-e2e] script upsert: ${script.id} "${script.label}"`);

  const result = await scriptVersionService.create({
    scriptId: script.id,
    manifest,
    status: 'published',
    label: 'v1',
    note:
      'E2E 综合测试剧本。两章（chapter 1/2）+ 两场景（hall/deep_stacks）+ 两角色（jenkins/luna，每角色 3 种 emotion）。验证章节切换、立绘切换、场景切换、选项交互。',
  });
  if (result.created) {
    console.log(
      `[seed-test-e2e] 新版本 v${result.version.versionNumber} published (id=${result.version.id})`,
    );
  } else {
    console.log(
      `[seed-test-e2e] 内容 hash 未变，复用 v${result.version.versionNumber}`,
    );
  }

  // 绑 production LLM config（取第一条）
  const [cfg] = await db.select().from(schema.llmConfigs).limit(1);
  if (cfg) {
    await db
      .update(schema.scripts)
      .set({ productionLlmConfigId: cfg.id })
      .where(eq(schema.scripts.id, script.id));
    console.log(`[seed-test-e2e] productionLlmConfigId = ${cfg.id}`);
  }

  // 统计 segments 分布
  const allSegs = manifest.chapters.flatMap((ch) => ch.segments);
  const segCount = allSegs.length;
  const tokenTotal = allSegs.reduce((n, s) => n + s.tokenCount, 0);
  const ch1Count = manifest.chapters[0]!.segments.length;
  const ch2Count = manifest.chapters[1]!.segments.length;
  console.log(
    `[seed-test-e2e] segments total=${segCount}（ch1 chapter=${ch1Count}, ch2 chapter=${ch2Count}）tokens~${tokenTotal}`,
  );

  console.log('\n[seed-test-e2e] === E2E 验证清单 ===');
  console.log('【基础】');
  console.log('  1. 首页 / 编辑器能看到 "E2E 测试 · 图书馆奇遇" 卡片');
  console.log('  2. 点"开始"创建 playthrough 能启动，WS 连上');
  console.log('  3. 首轮 LLM 调 change_scene 渲染大厅背景 + Jenkins 立绘');
  console.log('【章节 1】');
  console.log('  4. 对话几轮（友好），观察 trust_jenkins 增长（看 debug panel）');
  console.log('  5. 观察 Jenkins 立绘从 neutral → smile（change_sprite 生效）');
  console.log('  6. 明确表达"想去深处看看"，GM 应该切 chapter 到 2');
  console.log('【章节切换】');
  console.log('  7. chapter=2 时 debug panel 的 segments 列表应该看到 ch2-mission / luna-character 激活');
  console.log('  8. ch1-mission / jenkins-character 应该不再在 prompt 里（injectionRule 过滤）');
  console.log('  9. 背景切换到 deep_stacks，Luna 的立绘出现');
  console.log('【章节 2】');
  console.log(' 10. 和 Luna 对话，观察她的立绘变化（reading → look_up → smile）');
  console.log(' 11. met_luna 和 knows_secret state 更新');
  console.log(' 12. 对话几轮后 GM 调 end_scenario，playthrough 状态转 finished');
  console.log('【其他】');
  console.log(' 13. 每轮 signal_input_needed 给 2-3 个选项，Backlog 能看到历史选择');
  console.log(' 14. Langfuse trace：每回合一条 generation span（方案 B 的 turn-bounded 生效）');
  console.log(' 15. 断线重连（刷新页面）后 UI 恢复正确（scene / 立绘 / 选项）');
  console.log(
    '\n[seed-test-e2e] done. 前端地址：http://localhost:5173/scripts/' +
      script.id,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error('[seed-test-e2e] 致命错误:', err);
  process.exit(1);
});
