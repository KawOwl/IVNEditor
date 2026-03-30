# 计划：标签重命名 + 角色面板 + 模型配置

## 需求概述

1. "动态动作"标签改为"允许根据角色行动习得新动作"，确认实现逻辑正确
2. 主游戏界面添加可折叠的角色面板（显示设定、动作等）
3. 设置界面新增模型配置Tab（对话模型 + embedding模型，支持多协议）

---

## Step 1: 标签重命名 + 逻辑确认

**改动文件**: `src/player/ChatInput.tsx`, `src/player/player-store.ts`

- ChatInput.tsx: `"动态动作"` → `"允许根据角色行动习得新动作"`
- player-store.ts: 系统消息 `"动态动作生成已开启/关闭"` → `"已允许/禁止根据角色行动习得新动作"`

**逻辑确认**: 当前实现是在玩家介入发送消息后、GOAP规划前，根据玩家意图调用 DeepSeek 判断是否需要生成新的 GOAP 动作。这符合"根据角色行动习得新动作"的概念——角色在执行行动时，如果遇到新情境（玩家引导），可以学会新的行动方式。

---

## Step 2: 角色面板组件

**新建文件**: `src/player/CharacterPanel.tsx`

设计：
- 位于游戏界面左侧，可折叠（默认折叠）
- 折叠时显示窄条 + 角色名首字 + "▸"
- 展开时显示 280px 宽面板，包含：
  - **基本信息**: 名字、背景、外貌
  - **性格特质**: personality traits + intensity 进度条
  - **价值观**: values 标签
  - **说话风格**: speechStyle
  - **当前目标**: 短期目标列表（从 debug store 读取 currentGoal）
  - **动作库**: GOAP actions 列表（名字 + 描述 + cost/timeCost）
  - 动态生成的动作用特殊标记区分

数据来源：
- `useCharacterStore` → getPersona(characterId), getGoals(characterId)
- `useDebugStore` → currentGoal
- GOAP actions 从 App.tsx 传入 (coreLoop.config.goapActions)

**改动文件**: `src/App.tsx`
- 在 game view 的 layout 中，rendererWrap 左侧添加 CharacterPanel
- 将 characterId 和 goapActions 传给 CharacterPanel

布局结构：
```
<div style={gameContent}>
  ├─ controlBar
  ├─ <div style={mainArea}>  ← 新增 flex row
  │  ├─ CharacterPanel (collapsed: 32px / expanded: 280px)
  │  └─ <div style={rendererWrap}> (flex: 1)
  │     └─ GameRenderer
  └─ ChatInput
</div>
```

---

## Step 3: 模型配置 Store

**新建文件**: `src/settings/model-config-store.ts`

```typescript
type ModelProtocol = 'openai' | 'anthropic' | 'gemini' | 'deepseek';

interface ModelConfig {
  protocol: ModelProtocol;
  baseURL: string;
  apiKey: string;
  modelName: string;
}

interface ModelConfigState {
  chatModel: ModelConfig;
  embeddingModel: ModelConfig;
  setChatModel(config: Partial<ModelConfig>): void;
  setEmbeddingModel(config: Partial<ModelConfig>): void;
  loadFromEnv(): void;  // 从 env 读取 DEEPSEEK_API_KEY 预填
  save(): void;         // 存入 localStorage
  load(): void;         // 从 localStorage 读取
}
```

默认值（DeepSeek）：
- chatModel: `{ protocol: 'deepseek', baseURL: 'https://api.deepseek.com/v1', apiKey: import.meta.env.VITE_DEEPSEEK_API_KEY, modelName: 'deepseek-chat' }`
- embeddingModel: `{ protocol: 'deepseek', baseURL: 'https://api.deepseek.com/v1', apiKey: '', modelName: '' }`

每种协议的默认 baseURL：
- openai: `https://api.openai.com/v1`
- anthropic: `https://api.anthropic.com`
- gemini: `https://generativelanguage.googleapis.com/v1beta`
- deepseek: `https://api.deepseek.com/v1`

持久化：使用 localStorage（轻量，适合配置数据）

---

## Step 4: 模型配置 UI

**新建文件**: `src/settings/ModelConfig.tsx`

设置界面新增第4个Tab: `"🔧 模型配置"`

UI 布局：
```
模型配置
├─ 对话模型 (Chat Model)
│  ├─ 协议类型: <select> [OpenAI | Anthropic | Gemini | DeepSeek]
│  ├─ Base URL: <input> (切换协议自动填入默认URL)
│  ├─ API Key: <input type="password"> (如果env有DEEPSEEK_API_KEY自动带入)
│  └─ 模型名称: <input> (默认值随协议变化)
│
├─ Embedding模型
│  ├─ 协议类型: <select>
│  ├─ Base URL: <input>
│  ├─ API Key: <input type="password">
│  └─ 模型名称: <input>
│
└─ 保存按钮
```

**改动文件**:
- `src/settings/SettingsScreen.tsx`: 添加第4个tab
- `src/settings/settings-store.ts`: 添加 `'model'` tab type

---

## Step 5: 接入模型配置到 Agent 系统

**改动文件**: `src/agents/deepseek.ts` → 重命名/重构为 `src/agents/model-provider.ts`

核心改动：不再硬编码 DeepSeek，而是根据 model-config-store 动态创建 provider：

```typescript
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { useModelConfigStore } from '../settings/model-config-store';

export function getChatModel() {
  const config = useModelConfigStore.getState().chatModel;
  const provider = createOpenAICompatible({
    name: config.protocol,
    baseURL: config.baseURL,
    apiKey: config.apiKey,
  });
  return provider.chatModel(config.modelName);
}
```

所有 agent 文件改为调用 `getChatModel()` 替代直接导入 `deepseekChat`：
- `src/agents/cognition.ts`
- `src/agents/director.ts`
- `src/agents/script-generator.ts`
- `src/agents/goap-generator.ts`

**注意**: Anthropic 和 Gemini 协议实际上也可以通过 OpenAI-compatible adapter 使用（如果用户配的是兼容端点），或者后续可以按需引入 `@ai-sdk/anthropic`、`@ai-sdk/google`。当前阶段统一用 `@ai-sdk/openai-compatible`，因为大多数厂商都提供 OpenAI 兼容 API。

---

## Step 6: TypeScript 检查 + E2E 验证

- `npx tsc --noEmit` 确保零错误
- Preview 验证：
  - 设置界面第4个tab渲染正常
  - 模型配置表单可填写、保存
  - 游戏界面角色面板可展开/折叠
  - 标签文本已更新

---

## 文件变更汇总

| 文件 | 动作 |
|------|------|
| `src/player/ChatInput.tsx` | 修改（标签重命名） |
| `src/player/player-store.ts` | 修改（系统消息文案） |
| `src/player/CharacterPanel.tsx` | **新建** |
| `src/App.tsx` | 修改（添加角色面板到game布局） |
| `src/settings/model-config-store.ts` | **新建** |
| `src/settings/ModelConfig.tsx` | **新建** |
| `src/settings/SettingsScreen.tsx` | 修改（添加第4个tab） |
| `src/settings/settings-store.ts` | 修改（tab类型扩展） |
| `src/agents/deepseek.ts` | 重构为动态provider |
| `src/agents/cognition.ts` | 修改（使用getChatModel） |
| `src/agents/director.ts` | 修改（使用getChatModel） |
| `src/agents/script-generator.ts` | 修改（使用getChatModel） |
| `src/agents/goap-generator.ts` | 修改（使用getChatModel） |
| `src/vite-env.d.ts` | 可能修改（添加新env类型） |
