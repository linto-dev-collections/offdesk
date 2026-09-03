export type WorkerEnv = {
  DB: D1Database;
  PLANS: R2Bucket;
  GATEWAY: DurableObjectNamespace;

  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  AUTH_ALLOWED_EMAILS: string;

  DISCORD_BOT_TOKEN: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_APPLICATION_ID: string;
  OWNER_DISCORD_USER_ID: string;
  OFFDESK_TOKEN: string;
  FIRE_TOKEN_KEY: string;

  LOCAL_DEV?: string;
};

export const PRODUCTION_REQUIRED_ENV_NAMES = [
  "BETTER_AUTH_URL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
] as const satisfies readonly (keyof WorkerEnv)[];

/**
 * **宣言はするが `assertEnv` では要求しない**環境変数（P2）。
 *
 * これらが欠けたときに落ちるのは**それを使う入口だけ**にする:
 *
 * | 変数 | 欠けたときの振る舞い |
 * | --- | --- |
 * | `DISCORD_PUBLIC_KEY` | `POST /discord/interactions` が 503（計画 P2 §2） |
 * | `OWNER_DISCORD_USER_ID` | `isOwner` が常に false ＝ 誰も通らない（要件 `I-2`） |
 * | `OFFDESK_TOKEN` | Bearer の口が全拒否（脅威 2） |
 * | `FIRE_TOKEN_KEY` | 投入と起動が失敗する（画面とログインは生きる） |
 * | `DISCORD_BOT_TOKEN` / `DISCORD_APPLICATION_ID` | Discord への投稿が失敗する |
 *
 * **`PRODUCTION_REQUIRED_ENV_NAMES` に入れない理由。** あちらに入れると 1 つ欠けただけで
 * `assertEnv` が全リクエストを 500 にする。ログイン画面まで落ちると、**設定を直すために
 * 見たい管理画面が見られない**。要件 `I-2`（未設定なら誰も通さない）は入口ごとの
 * fail-closed で満たすので、起動時に落とす必要がない。
 *
 * 一覧としては保つ —— `release/env-required.test.ts` が
 * `alchemy.run.ts` / `.env.example` / `ci.yml` との食い違いを見張る。
 */
export const ENDPOINT_GATED_ENV_NAMES = [
  "DISCORD_BOT_TOKEN",
  "DISCORD_PUBLIC_KEY",
  "DISCORD_APPLICATION_ID",
  "OWNER_DISCORD_USER_ID",
  "OFFDESK_TOKEN",
  "FIRE_TOKEN_KEY",
] as const satisfies readonly (keyof WorkerEnv)[];

export type AppBindings = {
  Bindings: WorkerEnv;
};

const isLocalDev = (env: Partial<WorkerEnv>): boolean =>
  env.LOCAL_DEV === "true";

const isBlank = (value: string | undefined): boolean =>
  value === undefined || value.trim() === "";

/**
 * **未設定の入口用の検査。** `ENDPOINT_GATED_ENV_NAMES` の変数は本番でも欠けうるので、
 * 型が `string` であっても `undefined` が来る前提で読む（`.trim()` を直に呼ぶと
 * 「503 を返すはずの経路が TypeError で 500 になる」）。
 */
export const isConfigured = (value: string | undefined): boolean =>
  !isBlank(value);

export function assertEnv(env: Partial<WorkerEnv>): void {
  const missing: string[] = [];

  if (env.DB === undefined) missing.push("DB");
  if (env.PLANS === undefined) missing.push("PLANS");
  if (env.GATEWAY === undefined) missing.push("GATEWAY");

  if (isBlank(env.BETTER_AUTH_SECRET)) missing.push("BETTER_AUTH_SECRET");
  if (isBlank(env.AUTH_ALLOWED_EMAILS)) missing.push("AUTH_ALLOWED_EMAILS");

  if (!isLocalDev(env)) {
    for (const name of PRODUCTION_REQUIRED_ENV_NAMES) {
      if (isBlank(env[name])) missing.push(name);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `必須のバインディング／環境変数が ${missing.length} 個ありません: ${missing.join(", ")}。\n` +
        "バインディングは apps/app/wrangler.jsonc と packages/infra/alchemy.run.ts の\n" +
        "両方を、環境変数は .env.example の一覧を確認してください。\n" +
        'ローカル開発でこれが出た場合は、wrangler.jsonc の vars に LOCAL_DEV="true" が\n' +
        "あるかを確認してください。",
    );
  }
}
