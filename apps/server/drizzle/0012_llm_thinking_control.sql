-- 0012: 在 llm_configs 上重新加 thinking_enabled + reasoning_effort
--
-- 背景：migration 0006 当时删掉了 thinking_enabled（因为 deepseek-chat 忽略
-- 该参数 + 老 ReasoningFilter 是启发式死码）。但 DeepSeek V4 系列（v4-flash/
-- v4-pro）thinking 模式真实可控，**且带 tool_calls 时要求 reasoning_content
-- 必须回传**，否则 API 报 "The reasoning_content in the thinking mode must
-- be passed back to the API"（400）。
--
-- 存量 playthrough 的 narrative_entries.reasoning 列 = null，拿 V4 thinking
-- 模型重放会 100% 挂。短期 escape hatch：让管理员对配置关闭 thinking。
--
-- 两列都可空：
--   thinking_enabled NULL  → 不向 API 传 thinking 字段，让模型走默认
--                 TRUE   → 传 thinking:{type:'enabled'}
--                 FALSE  → 传 thinking:{type:'disabled'}（escape hatch）
--   reasoning_effort NULL → 不传，让模型走默认（通常是 'high'）
--                   'high' / 'max' → 传 reasoning_effort:'<value>'
--
-- 参考：
--   https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
--   .claude/plans/gm-turn-closure-and-tool-history-audit.md

ALTER TABLE "llm_configs" ADD COLUMN "thinking_enabled" boolean;
ALTER TABLE "llm_configs" ADD COLUMN "reasoning_effort" text;
