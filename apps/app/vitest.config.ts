import path from "node:path";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(
            path.join(import.meta.dirname, "../../packages/db/src/migrations"),
          ),
          BETTER_AUTH_SECRET: "test-secret-not-used-in-any-real-deployment",
          BETTER_AUTH_URL: "http://localhost:5173",
          GOOGLE_CLIENT_ID: "test-google-client-id",
          GOOGLE_CLIENT_SECRET: "test-google-client-secret",
          AUTH_ALLOWED_EMAILS: "offdesk.me@gmail.com",

          DISCORD_BOT_TOKEN: "test-discord-bot-token",
          DISCORD_PUBLIC_KEY: "",
          DISCORD_APPLICATION_ID: "test-application-id",
          OWNER_DISCORD_USER_ID: "111111111111111111",
          OFFDESK_TOKEN: "test-offdesk-token-0123456789abcdef",
          // base64 の 32 バイト（AES-256）。テスト専用の固定値。
          FIRE_TOKEN_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",

          ASK_HOLD_MS: "300",
          ASK_POLL_MS: "5",
          ASK_PROGRESS_MS: "10",
          ASK_SILENT_HOLD_MS: "150",
          ASK_TOUCH_MS: "10",

          INBOUND_HELD_WINDOW_MS: "200",
          INBOUND_ACTIVE_WINDOW_MS: "2000",
        },
      },
    })),
  ],
  test: {
    name: "app",
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "test/release/**"],
    setupFiles: ["./test/vitest.setup.ts"],
  },
});
