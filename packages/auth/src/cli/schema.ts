import { createAuth } from "../index.ts";

/*
  Better Auth CLI（`auth generate`）にスキーマを読ませるためだけのエントリ。

    pnpm -F @offdesk/auth auth:generate

  CLI は「`auth` という名前の export か default export」を要求するが、本体は Workers の
  env を引数に取る `createAuth(env)` なので、`src/index.ts` を直接指すと
  `Couldn't read your auth config` で落ちる。ここで偽の env を渡して組み立てる。

  **`usePlural: true` は adapter の設定なので、`--adapter drizzle --dialect sqlite` で
  代用できない。** 本物の `createAuth` を通す必要がある。
*/

const unavailable = (): never => {
  // 生成時に DB へ触る経路があれば、黙って空の結果を返すより落ちた方がよい。
  throw new Error("スキーマ生成では D1 に触りません");
};

/**
 * `D1Database` の代役。**`as` を書かずに済むよう、5 つのメソッドを全部並べる。**
 * `auth generate` はスキーマの形だけを読むので、1 度も呼ばれない。
 */
const unusedD1: D1Database = {
  prepare: unavailable,
  batch: unavailable,
  exec: unavailable,
  withSession: unavailable,
  dump: unavailable,
};

export const auth = createAuth({
  DB: unusedD1,
  // **どれも生成専用の値。** 実行時には 1 度も使われない。
  BETTER_AUTH_SECRET: "schema-generation-only-not-a-real-secret",
  BETTER_AUTH_URL: "http://localhost:5173",
  GOOGLE_CLIENT_ID: "schema-generation-only",
  GOOGLE_CLIENT_SECRET: "schema-generation-only",
  // 空 ＝ 誰も許可しない。`validateUserInfo` は生成では呼ばれない。
  AUTH_ALLOWED_EMAILS: "",
});
