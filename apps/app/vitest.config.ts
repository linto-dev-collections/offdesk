import path from "node:path";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Worker 結合テスト。
 *
 * `@cloudflare/vitest-pool-workers` 0.22 の現行 API は `defineWorkersConfig` ではなく
 * `cloudflareTest` プラグイン ＋ `defineConfig`。Vitest 4.1 以上が必要。
 *
 * D1 も R2 も実物（miniflare）を使い、外部 API は呼ばせない。
 */
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          /*
            マイグレーションの中身はテスト専用バインディング経由で worker 側へ渡す
            （`applyD1Migrations` も `node:fs` も Node 側からは worker に届かない）。

            **P0 の migrations は空。** `readD1Migrations` は空配列を返し、
            `applyD1Migrations` は何もしない（P1 で最初の 1 本が入る）。
          */
          TEST_MIGRATIONS: await readD1Migrations(
            path.join(import.meta.dirname, "../../packages/db/src/migrations"),
          ),
        },
      },
    })),
  ],
  test: {
    name: "app",
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
    setupFiles: ["./test/vitest.setup.ts"],
  },
});
