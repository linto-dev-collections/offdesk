/**
 * Worker のバインディングと環境変数。
 *
 * `wrangler types` の生成物（`worker-configuration.d.ts`）は使わない。理由が 2 つある。
 *
 * 1. あの生成物は `wrangler.jsonc` から型を作るが、このプロジェクトの wrangler.jsonc は
 *    ローカル専用で、本番のバインディングは `packages/infra/alchemy.run.ts` が持つ。
 *    ローカルの設定を本番の型として扱うことになる。
 * 2. `wrangler types` は `--strict-vars` が既定 true で、`vars` の値をリテラル型にする。
 *    `LOCAL_DEV: "true"` という型が生成され、本番では嘘になる。
 *
 * **この型は「本番の Worker が受け取る形」を書く。** ローカル開発と結合テストは
 * `LOCAL_DEV` が立った環境で、後続フェーズの値を持たない。その差は `assertEnv` が
 * `Partial<WorkerEnv>` を受けて吸収する——「まだ検証していない実行時の env」と
 * 「検証済みの本番の env」を別の型で表す、という分け方にしてある。
 *
 * **バインディングを増やしたときは 3 か所を揃える** — `wrangler.jsonc` /
 * `packages/infra/alchemy.run.ts` / ここ。
 */
export type WorkerEnv = {
  /** D1（テーブル定義書 §4）。 */
  DB: D1Database;
  /** 実装計画の本文（要件 F-H）。 */
  PLANS: R2Bucket;
  /** Discord Gateway の常駐接続（要件 F-E）。**1 つだけ。** */
  GATEWAY: DurableObjectNamespace;

  /** セッション Cookie とトークンの署名鍵。**全ステージで必須。** */
  BETTER_AUTH_SECRET: string;
  /**
   * 公開オリジン。Cookie の `Secure` 判定と Origin 検査に使う。
   *
   * **本番で既定値へ倒さない**（要件 `F-G6`）。localhost のまま本番に出ると
   * 「ログインは通るのに状態変更 API が全部 403」という最も分かりにくい壊れ方をする。
   */
  BETTER_AUTH_URL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /**
   * ログインを許すメール（`,` 区切り）。
   *
   * **空なら誰も通さない**（要件 `I-2`）。空文字どうしが一致して全開になる形を作らない。
   */
  AUTH_ALLOWED_EMAILS: string;

  /**
   * ローカル開発・結合テストの目印。**本番では bind しない。**
   *
   * `wrangler.jsonc` の `vars`（ローカル専用の設定ファイル）だけが `"true"` を置き、
   * `alchemy.run.ts` は prod 以外のステージにだけ渡す。`assertEnv` はこれが `"true"`
   * でなければ**本番として扱い**、必須の環境変数が揃っていなければ落ちる。
   *
   * **判定を「本番の目印」ではなく「ローカルの目印」にしているのが要点。** 本番側に
   * 目印を置く形にすると、その 1 個を渡し忘れた本番が検査を素通りする。
   * 未設定＝厳しい側に倒れる（fail-closed）向きに揃えてある。
   */
  LOCAL_DEV?: string;
};

/**
 * **本番で必須の環境変数。この配列が唯一の定義。**
 *
 * バインディング（`DB` / `PLANS` / `GATEWAY`）は含めない。**文字列で渡ってくる
 * 「設定漏れが起こりうるもの」**だけを並べ、`assertEnv` がここを回して欠落を列挙する。
 *
 * `packages/infra/alchemy.run.ts` にデプロイ時の同じ一覧があり（あちらは Worker の
 * コードを import できない）、**2 つの一覧が一致していることを
 * `test/release/env-required.test.ts` が検査する**（P8 で入れる）。
 *
 * **P0 は 0 個。フェーズごとにここと alchemy.run.ts の 2 か所へ同時に足す**
 * （どちらか片方だけ足すと、デプロイは通るのに起動時に落ちる／その逆になる）。
 */
export const PRODUCTION_REQUIRED_ENV_NAMES = [
  // P1（認証）
  "BETTER_AUTH_URL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
] as const satisfies readonly (keyof WorkerEnv)[];

/** Hono の型パラメータ。 */
export type AppBindings = {
  Bindings: WorkerEnv;
};

/** ローカル開発・結合テストか。**`"true"` 以外はすべて本番として扱う**（fail-closed）。 */
const isLocalDev = (env: Partial<WorkerEnv>): boolean =>
  env.LOCAL_DEV === "true";

/** 未設定・空文字・空白だけを「無い」とみなす。 */
const isBlank = (value: string | undefined): boolean =>
  value === undefined || value.trim() === "";

/**
 * シークレット未設定・バインディング忘れのまま起動して 500 を撒き散らさないための
 * 起動時検査。
 *
 * 引数を `Partial` で受けるのは、**まだ検証していない実行時の env** を表すため。
 * `WorkerEnv` で受けると「バインディングが必ずある」と型が言っているのに存在検査を
 * 書いていることになり、検査自体がテストできない。
 *
 * **1 つ見つけて止めるのではなく、欠けているものを全部数える。** 1 つずつ throw すると
 * 「直す → deploy → また落ちる」を繰り返すことになる。**値は出さない。**
 * 名前だけを並べる（plans/security.md 脅威 12）。
 */
export function assertEnv(env: Partial<WorkerEnv>): void {
  const missing: string[] = [];

  /*
    バインディング忘れは実行時に `undefined.get()` という分かりにくい形で出る。
    3 か所（wrangler.jsonc / alchemy.run.ts / WorkerEnv）を揃え忘れたことをここで言う。
  */
  if (env.DB === undefined) missing.push("DB");
  if (env.PLANS === undefined) missing.push("PLANS");
  if (env.GATEWAY === undefined) missing.push("GATEWAY");

  /*
    **全ステージで必須の 2 つ。** ローカルでも本物の Google OAuth を踏む約束なので
    （迂回路を作らない）、無ければローカルでも落とす。
    残り 3 つ（`BETTER_AUTH_URL` / `GOOGLE_*`）は本番だけ必須で、下で見る。
  */
  if (isBlank(env.BETTER_AUTH_SECRET)) missing.push("BETTER_AUTH_SECRET");
  if (isBlank(env.AUTH_ALLOWED_EMAILS)) missing.push("AUTH_ALLOWED_EMAILS");

  /*
    ここから下は本番だけの検査。ローカル（`LOCAL_DEV=true`）は後続フェーズの
    環境変数が 1 つも無い状態で起動できる。
  */
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
