import { SESSION_CACHE_SECONDS } from "@offdesk/contract";
import { createDb } from "@offdesk/db";
import * as schema from "@offdesk/db/schema";
import { gateEmail, parseAllowedEmails } from "@offdesk/domain";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

/** スマホから計画を開くのに毎回のログインを避ける（要件 F-E5）。 */
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
/** 操作のたびに延長する。1 日以上経っていたら書き戻す。 */
const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24;

export type AuthEnv = Readonly<{
  DB: D1Database;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  AUTH_ALLOWED_EMAILS: string;
}>;

export type Auth = ReturnType<typeof createAuth>;

/**
 * Better Auth を組み立てる。
 *
 * **Workers は env がリクエストごとに来るので、モジュールスコープで 1 度作れない。**
 * Worker 側でリクエストごとに呼ぶ（D1 に「接続」の概念は無いので安い）。
 *
 * **この関数の外で `env` を触らない。** `auth generate` の CLI は Node でこの
 * ファイルを読むので、モジュールトップで D1 を掴むと生成が落ちる。
 */
export function createAuth(env: AuthEnv) {
  const isHttps = env.BETTER_AUTH_URL.startsWith("https://");
  const allowed = parseAllowedEmails(env.AUTH_ALLOWED_EMAILS);

  return betterAuth({
    database: drizzleAdapter(createDb(env.DB), {
      provider: "sqlite",
      schema,
      // offdesk 所有の 7 表が全部複数形なので揃える（テーブル定義書 §2）。
      // **後から変えられない**（変えると認証 4 表すべての改名マイグレーションになる）。
      usePlural: true,
    }),

    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    // Google Cloud Console のリダイレクト URI と `run_worker_first` が
    // このパスを指しているので、既定値のままでも明示して動かないようにする。
    basePath: "/api/auth",
    // SPA と API が同一オリジン。ここに無い Origin からの状態変更は Better Auth が弾く。
    trustedOrigins: [env.BETTER_AUTH_URL],

    // パスワードは持たない（要件 F-G1）。
    emailAndPassword: { enabled: false },

    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
      },
    },

    user: {
      /*
        **許可外を「ユーザー作成の前」で止める**（要件 F-G3・plans/security.md 脅威 6）。

        `validateUserInfo` は DB への書き込み前に走り、error を返すと 403 になる。
        `databaseHooks.user.create.before` より前なので、**拒否したメールの行が残らない。**

        判定そのものは `@offdesk/domain` の `gateEmail`（純粋関数）に置いてある。
        ここに直接書くと、検査するのに Google の OAuth を踏むしかなくなる。
      */
      validateUserInfo: ({ user }) => {
        const gate = gateEmail(allowed, user.email);
        return gate.allowed
          ? undefined
          : { error: "not_allowed", errorDescription: gate.reason };
      },
    },

    session: {
      expiresIn: SESSION_MAX_AGE_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
      /*
        毎回 D1 を引かないための短命な署名付きキャッシュ。
        **client 側の gate も同じ値を `staleTime` に使う**（`@offdesk/contract`）。
        サーバーが 5 分より細かく知らないなら、client も細かく主張しない。
      */
      cookieCache: { enabled: true, maxAge: SESSION_CACHE_SECONDS },
    },

    rateLimit: {
      enabled: true,
      window: 60,
      max: 60,
      customRules: { "/sign-in/social": { window: 60, max: 10 } },
    },

    advanced: {
      /*
        **これを指定しないと全利用者が 1 つのバケットを共有する。**

        Better Auth の既定は `x-forwarded-for` を見るが、Cloudflare Workers には
        このヘッダが届かない。解決に失敗するとパス単位の単一バケットへ落ちるので、
        1 回の失敗で 60 秒間だれもログインできなくなる。
        `cf-connecting-ip` はエッジが必ず上書きする単一値で、クライアントから詐称できない。
      */
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      cookiePrefix: "offdesk",
      useSecureCookies: isHttps,
      defaultCookieAttributes: {
        httpOnly: true,
        // **`strict` にしない。** Discord のリンクからの遷移はトップレベル GET なので
        // `lax` で通るが、`strict` だと計画のリンクを踏むたびにログイン画面へ落ちる。
        sameSite: "lax",
        secure: isHttps,
        path: "/",
      },
      // `disableCSRFCheck` と `disableOriginCheck` は既定（false）のまま。**触らない。**
    },
  });
}
