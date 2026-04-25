-- 0006: 删除 llm_configs 表的 thinking_enabled / reasoning_filter_enabled 列
--
-- 背景：通过 scripts/verify-deepseek-reasoning.mts 的实测确认：
--   - DeepSeek-chat 的 enable_thinking 参数对模型行为无效（chat 模型不产生 reasoning）
--   - deepseek-reasoner 走 AI SDK 原生 reasoning-delta 流，不需要过滤器
--   - ReasoningFilter 的启发式（检测 --- / ## / ** 标记）是死代码
--
-- 决定：两个字段删除，引擎统一走 AI SDK 原生通道。
-- 参考：SOP 讨论 Round 3 后续记录 / verify-deepseek-reasoning.mts 脚本输出

ALTER TABLE "llm_configs" DROP COLUMN IF EXISTS "thinking_enabled";
ALTER TABLE "llm_configs" DROP COLUMN IF EXISTS "reasoning_filter_enabled";
