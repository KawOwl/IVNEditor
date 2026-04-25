-- 0010: narrative_entries 结构化 signal_input 事件
--
-- 见 .claude/plans/conversation-persistence.md
--
-- 改动：
--   1. 加 kind 列（默认 'narrative'）—— 区分条目语义类别
--        'narrative'    旁白 + 对话混合（现有 role='generate' 条目）
--        'signal_input' 一次 signal_input_needed 调用（role='system'，content=hint，payload={choices}）
--        'player_input' 玩家输入（role='receive'，payload={selectedIndex?, inputType}）
--   2. 加 payload jsonb —— 按 kind 自描述的结构化载荷
--   3. 删 tool_calls 列 —— 定义以来从未被生产代码写入（schema 里有、tests 里有、
--        game-session.ts 的 appendNarrativeEntry 两个调用点均未传），是 dead column。
--
-- 向后兼容：
--   - 老行 kind 默认 'narrative'，payload null，UI 行为不变
--   - tool_calls 生产行全是 null，drop 无损失
--   - 测试 fixture 里有写 tool_calls 的，drop 前用例要同步改为 kind/payload

-- Step 1: 加 kind 列（默认 'narrative'，老行自动归类）
ALTER TABLE "narrative_entries"
  ADD COLUMN "kind" text NOT NULL DEFAULT 'narrative';

-- Step 2: 加 payload 列（nullable，按 kind 自描述）
ALTER TABLE "narrative_entries"
  ADD COLUMN "payload" jsonb;

-- Step 3: 删 dead tool_calls 列
ALTER TABLE "narrative_entries"
  DROP COLUMN "tool_calls";
