import { createAuth } from "@offdesk/auth";
import { HealthOutput } from "@offdesk/contract";
import { getHealth } from "@offdesk/usecase";
import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";
import { type AppBindings, assertEnv, type WorkerEnv } from "./env.ts";
import { router } from "./rpc/router.ts";

const app = new Hono<AppBindings>();

// 契約から組んだハンドラは env を持たないのでモジュールスコープで 1 度作れる。
const rpc = new RPCHandler(router);

/*
  **バインディングと環境変数の検査を、どのルートより先に置く。**

  未設定のまま起動すると `undefined.prepare()` のような分かりにくい形で
  500 が出る。ここで名前を並べて落とせば、3 か所（wrangler.jsonc /
  alchemy.run.ts / env.ts）のどれを揃え忘れたかが 1 回で分かる。

  **応答は Hono の既定どおり素の 500 で、名前は返さない。** 欠けている名前は
  ログにだけ出る（`wrangler tail` / observability）。認証の要らない口から
  バインディングの構成を読み取れるようにしないため。ここまで来るのは事故のときだけで、
  設定漏れは `alchemy.run.ts` がデプロイ時に止める。

  毎リクエスト走るが中身は `undefined` の比較だけなので、
  1 回だけ走らせるための状態をモジュールに持たせる必要はない。
*/
app.use("*", async (c, next) => {
  assertEnv(c.env);
  await next();
});

/*
  生存確認。**認証を要らない唯一の API**（デプロイの確認と CI から叩く）。

  戻り値を契約（`HealthOutput`）で parse してから返すのは、
  境界の形をコードで固定するため（計画 README §2-3「境界は parse する」）。
*/
app.get("/api/health", (c) => c.json(HealthOutput.parse(getHealth())));

/*
  Better Auth の口。**oRPC より前に置く**（`/api/auth/*` を先に取る）。
  Google Cloud Console のリダイレクト URI もこのパスを指している。
*/
app.on(["GET", "POST"], "/api/auth/*", (c) =>
  createAuth(c.env).handler(c.req.raw),
);

/*
  oRPC（要件 `I-8`・`V-4`）。

  **セッションの解決は素の Hono ミドルウェアで先に済ませ、oRPC には解決済みの値だけ渡す。**
  oRPC のミドルウェアで解決すると、契約の外にある Better Auth の都合が
  手続きの型に混ざる。

  `matched` が false なら `next()` へ落とす——**`/rpc/*` に無い名前を
  oRPC が 404 として飲み込まず、Hono の 404 に揃える**ため。
*/
app.use("/rpc/*", async (c, next) => {
  const session = await createAuth(c.env).api.getSession({
    headers: c.req.raw.headers,
  });
  const { matched, response } = await rpc.handle(c.req.raw, {
    prefix: "/rpc",
    context: {
      session,
      env: c.env,
      waitUntil: (promise) => c.executionCtx.waitUntil(promise),
    },
  });
  return matched ? c.newResponse(response.body, response) : next();
});

/*
  **cron を宣言したら `scheduled` も出す。** 出さないと Cloudflare は 5 分ごとに
  `Handler does not export a scheduled() function` を記録し続ける
  （P8 まで 8 フェーズぶん、本当のエラーがその中に埋もれる）。

  **中身は P8 で入れる。** それまで何もしないのが正しい状態なので、
  ログも出さない（5 分ごとの出力は本当のエラーを埋もれさせる方に働く）。
*/
const scheduled: ExportedHandlerScheduledHandler<WorkerEnv> = () => {};

/*
  **`fetch` と `scheduled` を持つオブジェクトを default export する。**

  `satisfies` を使うのは**形の検査だけを効かせて `app.fetch` の型を保つ**ため。
  `:` で型注釈すると `fetch` が `ExportedHandlerFetchHandler`（引数 3 つが必須）に
  置き換わり、`app.fetch(request, env)` の 2 引数呼び出し（テストが使う形）が通らない。
*/
export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<WorkerEnv>;

/*
  Gateway の DO（P4 で中身を入れる）。

  **P0 で宣言だけ置くのは、DO を持つ Worker が 1 デプロイに乗ることを
  `V-3` で確かめるため。** 後から足すと、preview subdomain の有無・
  migrations の tag・課金の前提が全部動く。
*/
export { DiscordGatewayDO } from "./gateway/gateway.do.ts";
