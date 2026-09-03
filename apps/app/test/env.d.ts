import type { D1Migration } from "cloudflare:test";
import type { WorkerEnv } from "../src/worker/env.ts";

/**
 * `cloudflare:workers` の `env` は `Cloudflare.Env` 型で、プロジェクト側の宣言と
 * マージされる。`wrangler types` の生成物は使わない方針なので
 * （`src/worker/env.ts` のコメント）、ここで手書きの `WorkerEnv` を流し込む。
 */
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      /** `vitest.config.ts` が miniflare のバインディングとして注入する。 */
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
