/**
 * インフラ定義（要件 §10-6）。デプロイ時のリソースとバインディングはこのファイルが正本。
 *
 * **alchemy は 0.94.0 にキャレット無しで固定している。** npm の `latest` は
 * 2.0.0-beta（Effect ベースの作り直し）を指すため、上げると別 API が入る。
 */
import alchemy from "alchemy";
import {
  D1Database,
  DurableObjectNamespace,
  R2Bucket,
  Vite,
} from "alchemy/cloudflare";
import { CloudflareStateStore } from "alchemy/state";
import { config } from "dotenv";

/*
  ルートは Alchemy CLI だけが使うもの（`ALCHEMY_PASSWORD` 等）、apps/app は Worker が
  受け取るもの。分けている理由は plans/security.md 脅威 4
  （`@cloudflare/vite-plugin` が apps/app 側を `dist/<worker>/.dev.vars` へ平文で書き出す）。

  **CI かどうかで分岐しない。** `config()` は既定で既存の `process.env` を上書きしないので
  CI では secret が勝ち、ファイルも存在しないので no-op になる。分岐を書くと、手元から
  CI と同じ条件で 1 回出したいときに全部を export し直すことになる。
*/
config({ path: "../../.env.local" });
config({ path: "../../apps/app/.env.local" });

// 無いまま進むと `Cannot deserialize secret without password` という素の例外になり、
// 何を設定すればよいか分からない。
if (!process.env.ALCHEMY_PASSWORD) {
  throw new Error(
    "ALCHEMY_PASSWORD が未設定です。状態内のシークレットの暗号化・復号に使います。\n" +
      "  ローカル: リポジトリのルートの .env.local（apps/app/ ではありません）\n" +
      "  CI:      gh secret set ALCHEMY_PASSWORD\n" +
      '  作り方:  ALCHEMY_PASSWORD="$(openssl rand -base64 32)"\n' +
      "**変更すると既存の状態が読めなくなるので、一度決めたら変えないこと。**",
  );
}

const stage = process.env.ALCHEMY_STAGE ?? "dev";
const isProd = stage === "prod";

/**
 * 状態を Cloudflare 側に置くか、手元の `.alchemy/` に置くか。
 *
 * **`ALCHEMY_DEPLOY` を立てるのは CI だけ。** `package.json` の `deploy` スクリプトに
 * 焼き込むと「ローカルは `.alchemy/`」の分岐が死に、下の guard も発火しなくなる。
 */
const useRemoteState = process.env.ALCHEMY_DEPLOY !== undefined;

/*
  **prod は CI からしか出さない。** `useRemoteState` を立てずに prod を出すと、CI が
  Cloudflare 側へ書いた状態ではなく空の `.alchemy/` を正本として読み、すでに在る
  `offdesk-db-prod` を作り直しに行く（要件 `N-4` がいちばん壊れやすい経路）。
*/
if (isProd && !useRemoteState) {
  throw new Error(
    "prod へのデプロイは GitHub Actions（.github/workflows/ci.yml）から行います。\n" +
      "main に push すると deploy まで走ります。\n\n" +
      "手元から出すときは CI と同じ状態ストアを使ってください:\n" +
      "  ALCHEMY_DEPLOY=1 ALCHEMY_STAGE=prod pnpm deploy\n" +
      "（ルートの .env.local に ALCHEMY_STATE_TOKEN が必要。CI の secret と同じ値）",
  );
}

/**
 * 環境変数の値。**空文字と空白だけは「無い」とみなす。**
 *
 * `alchemy.env.X` を使わないのは、あれが `"X" in process.env` で判定するため——
 * `.env.example` を写した `.env.local` は全キーが `""` なので、必須の検査が素通りする。
 */
const varOf = (name: string): string | undefined => {
  const raw = process.env[name]?.trim();
  return raw === undefined || raw === "" ? undefined : raw;
};

const secretOf = (name: string) => {
  const value = varOf(name);
  return value === undefined ? undefined : alchemy.secret(value, name);
};

const optionalBindings = <T>(
  values: Readonly<Record<string, T | undefined>>,
): Readonly<Record<string, T>> =>
  Object.fromEntries(
    Object.entries(values).filter(
      (entry): entry is [string, T] => entry[1] !== undefined,
    ),
  );

/*
  唯一の定義は `apps/app/src/worker/env.ts` の同名の配列で、ここはその写し
  （このファイルは Alchemy CLI の直接のエントリなので Worker のコードを import しない）。
  **2 つが一致していることは P8 の `env-required` テストが検査する。**
*/
const PRODUCTION_REQUIRED_ENV_NAMES: readonly string[] = [
  // P1（認証）
  "BETTER_AUTH_URL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
];

// Worker 側の `assertEnv` は「動いてから」の検査なので、デプロイそのものは防げない。
// **1 つ見つけて止めるのではなく全部数える**（1 つずつ落とすと直しては落ちるを繰り返す）。
if (isProd) {
  const missing = PRODUCTION_REQUIRED_ENV_NAMES.filter(
    (name) => varOf(name) === undefined,
  );
  if (missing.length > 0) {
    throw new Error(
      `本番デプロイに必要な環境変数が ${missing.length} 個未設定です:\n` +
        missing.map((name) => `  - ${name}`).join("\n") +
        "\n空文字は未設定として扱います（.env.example を写したままの値は通りません）。",
    );
  }
}

const betterAuthSecret = secretOf("BETTER_AUTH_SECRET");
if (betterAuthSecret === undefined) {
  throw new Error(
    "BETTER_AUTH_SECRET が未設定です（openssl rand -base64 32）。\n" +
      "ローカルは apps/app/.env.local、CI は gh secret set で設定してください。",
  );
}

const authAllowedEmails = varOf("AUTH_ALLOWED_EMAILS");
if (authAllowedEmails === undefined) {
  throw new Error(
    "AUTH_ALLOWED_EMAILS が未設定です。ログインを許すメールを `,` 区切りで設定してください。\n" +
      "**空のまま deploy すると誰もログインできません**（要件 I-2 により空 ＝ 全拒否）。",
  );
}

const app = await alchemy("offdesk", {
  stage,
  password: process.env.ALCHEMY_PASSWORD,
  // CI の実行環境は毎回捨てられるので `.alchemy/` が残らない。
  // **公開の口が 1 つ増える**ので plans/security.md 脅威 18。
  ...(useRemoteState
    ? {
        stateStore: (
          scope: ConstructorParameters<typeof CloudflareStateStore>[0],
        ) =>
          new CloudflareStateStore(scope, {
            scriptName: "offdesk-alchemy-state",
          }),
      }
    : {}),
});

/** アプリ DB（テーブル定義書 §4）。`apac` は日本からの書き込み遅延を抑えるため。 */
const db = await D1Database("db", {
  migrationsDir: "../../packages/db/src/migrations",
  primaryLocationHint: "apac",
  /*
    **本番だけ、リソースを外しても DB を消さない**（要件 `N-4`）。既定は `delete: true` で、
    `pnpm destroy` やこの宣言を消した deploy で本番の D1 が丸ごと削除される。
    `false` なら Alchemy の状態からは外れるが実体は残る。
  */
  ...(isProd ? { delete: false } : {}),
});

/**
 * 実装計画の本文（要件 F-H）。
 *
 * `devDomain: false` は r2.dev 経由の公開を切るもの。既定も false だが、
 * **「付け忘れ」と「意図して付けない」を区別できるように書く**（閲覧はログイン必須）。
 */
const plans = await R2Bucket("plans", {
  locationHint: "apac",
  devDomain: false,
  // D1 と同じ理由。
  ...(isProd ? { delete: false } : {}),
});

/**
 * Discord Gateway の常駐接続（要件 F-E）。`className` は Worker が export する名前と揃える。
 *
 * **常駐 DO を 2 つ以上にしない。** 1 つで約 324,000 GB-s／月を使い、Workers Paid に
 * 含まれる 400,000 GB-s を 2 つで超える。
 */
const gateway = DurableObjectNamespace("gateway", {
  className: "DiscordGatewayDO",
  sqlite: true,
});

/**
 * Worker 1 本（静的アセット ＋ Hono）。要件 §10-6「1 デプロイ・1 オリジン」。
 *
 * `Vite` は `Website` のラッパで、SPA フォールバックを既定で入れる。
 */
export const web = await Vite("app", {
  /*
    **prod だけ名前を固定する。** 他ステージで固定すると Alchemy 既定の
    `<app>-<resource>-<stage>` 命名が崩れてステージ分離が壊れる。
    この名前が公開 URL の先頭ラベルになるので、変えると `BETTER_AUTH_URL`（P1）も
    一緒に変える必要がある（食い違うと状態変更 API が全部 403 になる）。
  */
  ...(isProd ? { name: "offdesk" } : {}),
  /*
    **`previewSubdomains` を渡さない。** Alchemy が version preview の subdomain を既定で
    有効にするのは Durable Object を使っていない Worker のときだけで、この Worker は
    `GATEWAY` を bind しているので自動で無効になる。明示的に `false` を渡しても同じだが、
    渡すと「DO を外したら preview が復活する」という条件が設定から見えなくなる。
  */
  cwd: "../../apps/app",
  entrypoint: "src/worker/index.ts",
  compatibility: "node",
  // **上げるときは `@cloudflare/vitest-pool-workers` が持つ workerd の対応日付を先に確認する**
  // （あちらが古いと `pnpm test` だけが起動できなくなる）。wrangler.jsonc と同じ値にする。
  compatibilityDate: "2026-08-22",
  assets: {
    directory: "dist/client",
    /*
      これが無いと、拡張子を持たない GET が SPA フォールバックに吸われて API が
      index.html を返す。**パスを足すたびに `apps/app/wrangler.jsonc` の同じ一覧にも足す。**
    */
    run_worker_first: [
      "/api/*",
      "/rpc/*",
      "/mcp",
      "/hooks/*",
      "/plans/*",
      "/p/*",
      "/discord/*",
      "/gateway/*",
    ],
  },
  build: "pnpm build",
  // **時刻は UTC。** `apps/app/wrangler.jsonc` と同じ値にする
  // （食い違うと「ローカルでは動くのに本番では起きない」になる。P8 のテストが突き合わせる）。
  crons: ["*/5 * * * *"],
  bindings: {
    DB: db,
    PLANS: plans,
    GATEWAY: gateway,
    // 値はコードに書かない。ローカルは apps/app/.env.local、CI は GitHub の secret から。
    BETTER_AUTH_SECRET: betterAuthSecret,
    AUTH_ALLOWED_EMAILS: authAllowedEmails,
    ...optionalBindings<string | ReturnType<typeof alchemy.secret>>({
      BETTER_AUTH_URL: varOf("BETTER_AUTH_URL"),
      GOOGLE_CLIENT_ID: varOf("GOOGLE_CLIENT_ID"),
      GOOGLE_CLIENT_SECRET: secretOf("GOOGLE_CLIENT_SECRET"),
    }),
    ...(isProd ? {} : { LOCAL_DEV: "true" }),
  },
  // **バインディングを増やしたら 3 か所を揃える** — ここ・`apps/app/wrangler.jsonc`
  // （ローカル専用）・`apps/app/src/worker/env.ts` の `WorkerEnv`（型）。
});

console.log(`stage=${stage}  url=${web.url}`);

await app.finalize();
