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
          /*
            **認証の env はここで固定する。**

            `wrangler: { configPath }` を渡すと wrangler が `apps/app/.env.local` を
            読み、その値が worker の env に入る。そのままだと**テストが手元の
            設定ファイルの中身で結果を変える**（本物の Google の資格情報が入った
            時点でテストが外部を叩きうる）。ここで上書きして切り離す。

            **`AUTH_ALLOWED_EMAILS` や `BETTER_AUTH_URL` を変えて試したいテストは、
            `createAuth({ ...env, ... })` を直接呼ぶ**（env はこの 1 組だけ）。
          */
          BETTER_AUTH_SECRET: "test-secret-not-used-in-any-real-deployment",
          BETTER_AUTH_URL: "http://localhost:5173",
          GOOGLE_CLIENT_ID: "test-google-client-id",
          GOOGLE_CLIENT_SECRET: "test-google-client-secret",
          AUTH_ALLOWED_EMAILS: "offdesk.me@gmail.com",

          /*
            P2 の Discord 経路。**ここで固定しないと `.env.local` の本物が入り、
            テストが本番の Discord と Anthropic を叩きうる。**

            `DISCORD_PUBLIC_KEY` は空にしてある —— 既定を「未設定」にしておけば、
            503 を返す経路（要件 I-2）が既定で通り、鍵を要るテストだけが
            `withEnv` で自分の鍵を差す。
          */
          DISCORD_BOT_TOKEN: "test-discord-bot-token",
          DISCORD_PUBLIC_KEY: "",
          DISCORD_APPLICATION_ID: "test-application-id",
          OWNER_DISCORD_USER_ID: "111111111111111111",
          OFFDESK_TOKEN: "test-offdesk-token-0123456789abcdef",
          // base64 の 32 バイト（AES-256）。テスト専用の固定値。
          FIRE_TOKEN_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",

          /*
            P3a の握り。**既定をここで潰しておく**（要件 `N-9`「時間で待つテストを
            書かない」）。素の既定は 15 分なので、**上書きを忘れたテストが
            15 分ハングする**——それを踏まないために、全テストの既定を短くする。
            長さそのものを見たいテストだけが `{ ...env, ASK_HOLD_MS: "…" }` で伸ばす。
          */
          ASK_HOLD_MS: "300",
          ASK_POLL_MS: "5",
          ASK_PROGRESS_MS: "10",
          ASK_SILENT_HOLD_MS: "150",
          ASK_TOUCH_MS: "10",

          /*
            P4 の素の文。**握りの窓（60 秒）と作業中の窓（6 時間）を縮める** ——
            素の既定だと「起こし直し」の判定にテストが 6 時間かけることになる
            （要件 `N-9`「時間で待つテストを書かない」）。
            **2 つの値を別にしてある**のが要点で、同じにすると「窓が 2 つ別」を
            検査しているテストが通ってしまう。
          */
          INBOUND_HELD_WINDOW_MS: "200",
          INBOUND_ACTIVE_WINDOW_MS: "2000",
        },
      },
    })),
  ],
  test: {
    name: "app",
    include: ["test/**/*.test.ts"],
    /*
      `test/release` は node プールの別プロジェクト（`vitest.release.config.ts`）。
      あちらは `node:fs` でソースを走査するので workerd では動かない。
    */
    exclude: ["**/node_modules/**", "test/release/**"],
    setupFiles: ["./test/vitest.setup.ts"],
  },
});
