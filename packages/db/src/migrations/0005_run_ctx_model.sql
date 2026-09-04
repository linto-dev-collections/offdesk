-- drizzle-kit の生成物を**手で書き換えてある**（テーブル定義書 §7-2）。
--
-- 生成された SQL は `runs` を **DROP して作り直す**形だった。`asks` / `events` /
-- `inbox` の 3 表が `runs.run_key` を参照しているので、これは適用できない
-- （先頭の `PRAGMA foreign_keys=OFF` も D1 では効かない）。
--
-- 列を 1 本足すだけなので `ALTER TABLE ADD COLUMN` で足りる。**SQLite は
-- ADD COLUMN で列単位の CHECK を許す**（禁じられているのは PRIMARY KEY /
-- UNIQUE / GENERATED と、既定値が NULL でない NOT NULL）。名前を明示して、
-- schema の `check("runs_ctx_model_ck", ...)` と突き合わせられる形にしてある。
--
-- meta のスナップショットは生成されたまま置いてある（表単位の CHECK として
-- 記録されている）。**次の generate がまた再作成を出さないための土台**なので、
-- こちらだけを直して snapshot は触らない。
ALTER TABLE `runs` ADD COLUMN `ctx_model` text
  CONSTRAINT `runs_ctx_model_ck` CHECK (`ctx_model` IS NULL OR length(`ctx_model`) > 0);
