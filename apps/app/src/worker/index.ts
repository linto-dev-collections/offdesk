import { HealthOutput } from "@offdesk/contract";
import { getHealth } from "@offdesk/usecase";
import { Hono } from "hono";
import { type AppBindings, assertEnv } from "./env.ts";

const app = new Hono<AppBindings>();

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

export default app;

/*
  Gateway の DO（P4 で中身を入れる）。

  **P0 で宣言だけ置くのは、DO を持つ Worker が 1 デプロイに乗ることを
  `V-3` で確かめるため。** 後から足すと、preview subdomain の有無・
  migrations の tag・課金の前提が全部動く。
*/
export { DiscordGatewayDO } from "./gateway/gateway.do.ts";
