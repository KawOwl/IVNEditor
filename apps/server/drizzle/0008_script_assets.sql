-- 0008: script_assets 资产表（M4）
--
-- 资产跟 script 走（owner = script.author_user_id）。
-- storage_key 格式：scripts/<script_id>/<uuid>[.ext]
-- content_type 由上传时的 request header 决定（不校验白名单）。

CREATE TABLE "script_assets" (
  "id" text PRIMARY KEY NOT NULL,
  "script_id" text NOT NULL REFERENCES "scripts"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,                                   -- 'background' | 'sprite'
  "storage_key" text NOT NULL UNIQUE,
  "original_name" text,
  "content_type" text,
  "size_bytes" bigint,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX "idx_script_assets_script" ON "script_assets" ("script_id");
