// 暗街 实验 state schema 说明 —— caller-side prompt 段，注入到 system 前部。
// 让 LLM 知道每个 state 字段含义 + 何时该更新（loader 路由 + 暗街 引擎规则
// 业务字段）。否则 LLM 只看到 state JSON snapshot 不会主动维护 charactersOnStage
// 等关键路由字段。

export const STATE_SCHEMA_PROMPT = `\
# 暗街 state 字段说明

你看到的 state JSON 含以下字段。每次以下事件发生**必须** emit
<script type="application/x-state"> 更新对应字段。整体覆盖语义：列出的字段
被覆盖，未列出的保持不变。

引擎路由字段（影响下轮加载哪些剧本文件）：

- chapter: 1 | 2 | 3                  当前章节
- phase: number                       当前阶段（ch1: 1-5；ch2: 0-5；ch3: 1-4）
- charactersOnStage: string[]         当前在场角色短名（如 ["卡琳娜", "卡尔"]）；
                                      角色出场加入、离场移除
- factionsRelevant: string[]          当前涉及势力（如 ["凯旋门", "骷髅会"]）；
                                      场景涉及新势力时加入
- endingTrack?: string                估算结局走向（如 "白夜真结局" / "暗街深处"）
- loadAdjacentPhases: number          加载邻近阶段窗口（默认 1，无需更改）

业务状态字段（按引擎规则维护）：

- status: 'INIT' | 'ACTIVE'           会话状态机；玩家选择角色后 INIT→ACTIVE
- karina_attitude: number             卡琳娜态度值（-3~10）；按态度值表加减
- game_time: 'HH:MM'                  游戏内时间；每轮 +30 分钟（固定）
- pursueIndex: number                 推进指数（阶段一节奏管控）
- traceValue: number                  痕迹值（康纳线触发用）

更新触发清单：

| 事件 | 更新字段 |
|------|---------|
| 角色出场 | charactersOnStage 加入该角色 |
| 角色离场 | charactersOnStage 移除该角色 |
| 切换到新势力涉及的场景 | factionsRelevant 加入该势力 |
| 阶段推进 | phase += 1 |
| 时间过（必每轮）| game_time += 30 分钟 |
| 态度值变化 | karina_attitude 按引擎规则态度值表加减 |
| 状态机切换 | status: 'INIT' → 'ACTIVE'（玩家选完角色） |
| 痕迹值累积 | traceValue 按引擎规则加 |
| 推进指数累积 | pursueIndex 按引擎规则加 |
| 估算结局走向 | endingTrack 按对话/选择更新 |

**忘记更新这些字段** → loader 不会加载新角色 / 新势力 / 新阶段的剧本文件 →
你下轮看不到该出场的人物设定，叙事失真。**每轮检查并更新**。
`;
