-- drizzle-kit の生成物ではない。**手で書いた 1 本**（テーブル定義書 §7-2）。
--
-- 守りたいのは `runs_ctx_pair_ck` の続き:
--
--   (ctx_at IS NULL) = (ctx_output_tokens IS NULL)
--
-- 既存の `runs_ctx_pair_ck` は `ctx_at` と `ctx_used_tokens` しか結んでいないので、
-- `ctx_output_tokens` だけが入った行を DDL は止められない。
--
-- **CHECK では足せない。** SQLite は表単位の CHECK を後から足せず、
-- `ALTER TABLE ADD COLUMN` の列単位 CHECK は 1 列しか見られない。表の作り直しは
-- `asks` / `events` / `inbox` / `discord_interactions` の 4 表が `runs.run_key` を
-- 参照しているので適用できない（`release/migrations.test.ts` が禁じている）。
--
-- **トリガなら足せる。** 判定を書く場所が 1 つ増えるが、
-- 「気をつける」ではなく「構造で守る」側に留まる。
--
-- `ctx_model` は**わざと結んでいない。** あれは NULL が「モデルが分からない」を
-- 意味する正当な値で（`updateContextUsage` が `model ?? null` を書く）、
-- 結ぶと通報のたびに落ちる。
CREATE TRIGGER `runs_ctx_output_pair_bi`
BEFORE INSERT ON `runs`
WHEN (new.`ctx_at` IS NULL) <> (new.`ctx_output_tokens` IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'runs_ctx_output_pair: ctx_at and ctx_output_tokens must be set together');
END;
--> statement-breakpoint
CREATE TRIGGER `runs_ctx_output_pair_bu`
BEFORE UPDATE ON `runs`
WHEN (new.`ctx_at` IS NULL) <> (new.`ctx_output_tokens` IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'runs_ctx_output_pair: ctx_at and ctx_output_tokens must be set together');
END;
