import { defineConfig } from "drizzle-kit";

/**
 * マイグレーション SQL の**生成だけ**をここで行う。適用は wrangler
 * （`pnpm -F app db:migrate:local`）と Alchemy（本番）が `migrationsDir` から行う。
 *
 * **生成された SQL は必ず目で読む**（テーブル定義書 §7-2）。D1 は外部キー制約が既定で
 * 有効なので、drizzle-kit がテーブル再作成を選んだときの SQL は壊れることがある。
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema/index.ts",
  out: "./src/migrations",
  // 列名を書き忘れたときに camelCase がそのまま列名になるのを防ぐ。
  // `auth generate` の生成物は列名を明示するので、効くのは offdesk 側の表（P2）。
  casing: "snake_case",
});
