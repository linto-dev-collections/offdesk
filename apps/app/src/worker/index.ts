import { createAuth } from "@offdesk/auth";
import { gatewayFatalHint, HealthOutput, RPC_PREFIX } from "@offdesk/contract";
import { bearerMatches } from "@offdesk/domain";
import { getHealth } from "@offdesk/usecase";
import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";
import { admin } from "./admin/projects.ts";
import { handleInteraction } from "./discord/interactions.ts";
import { verifyDiscordSignature } from "./discord/verify.ts";
import { type AppBindings, assertEnv, type WorkerEnv } from "./env.ts";
import {
  ensureGateway,
  type GatewayReply,
  readGatewayStatus,
  resetGateway,
} from "./gateway/client.ts";
import { handleHookContext } from "./hooks/context.ts";
import { handleHookSessionEnd } from "./hooks/session-end.ts";
import { handleMcp } from "./mcp/server.ts";
import {
  handlePlanFinish,
  handlePlanUpload,
  handlePlanView,
} from "./plans/routes.ts";
import { router } from "./rpc/router.ts";

const app = new Hono<AppBindings>();

const rpc = new RPCHandler(router);

app.use("*", async (c, next) => {
  assertEnv(c.env);
  await next();
});

app.get("/api/health", (c) => c.json(HealthOutput.parse(getHealth())));

app.on(["GET", "POST"], "/api/auth/*", (c) =>
  createAuth(c.env).handler(c.req.raw),
);

app.route("/api/admin", admin);

/*
  MCP（P3a）。**認証を握る前に行う**（plans/security.md 脅威 16）——
  先にストリームを開いてから検査すると、その時点で資源を使っている。

  判定は `/api/admin/*` と同じ `bearerMatches` の 1 か所（脅威 2 の「判定は 1 箇所」）。
  `OFFDESK_TOKEN` が未設定・空文字なら誰も通らない（要件 `I-2`）。
  **失敗時のログに値を出さない。**
*/
app.post("/mcp", async (c) => {
  if (!bearerMatches(c.req.header("authorization"), c.env.OFFDESK_TOKEN)) {
    console.warn("[mcp] bearer mismatch", { path: c.req.path });
    return c.text("unauthorized", 401);
  }

  return await handleMcp(c.req.raw, c.env, {
    waitUntil: (promise) => c.executionCtx.waitUntil(promise),
  });
});

/*
  **サーバーから話しかける口を持たない**ので、GET は 405 を返す（仕様が許している）。
  握りは POST の応答そのものが SSE なので、別に開いてもらう必要がない。
*/
app.get("/mcp", (c) => c.text("method not allowed", 405));

/*
  Gateway の状態と張り直し（要件 `F-I7`・計画 P4 §3-7）。

  **Ed25519 ではなく Bearer / セッションで守る**（plans/security.md 脅威 1）——
  Discord から来るリクエストではないので、Discord の署名で守ろうとしない。

  **機械の口（Bearer）と画面（ログイン）の両方から叩ける。** `curl` を覚えなくても
  P7b の運用画面から張り直せるようにするため、判定を「どちらか」にしてある。
*/
const gateway = new Hono<AppBindings>();

gateway.use("*", async (c, next) => {
  if (bearerMatches(c.req.header("authorization"), c.env.OFFDESK_TOKEN)) {
    await next();
    return;
  }

  /*
    **ログイン済みのブラウザも通す。** 許可外のメールはそもそもユーザー行が
    作られない（`packages/auth` の `validateUserInfo`）ので、
    セッションがある ＝ 許可されたメール（要件 `F-G3`）。
  */
  const session = await createAuth(c.env).api.getSession({
    headers: c.req.raw.headers,
  });
  if (session !== null) {
    await next();
    return;
  }

  console.warn("[gateway] 認可されていない要求を拒否しました", {
    path: c.req.path,
  });
  return c.text("unauthorized", 401);
});

/**
 * `curl` に返す形。**契約に通した状態 ＋ `hint` の 1 行。**
 *
 * `hint` は `fatal` のときの**直し方**（文言は `packages/contract`）。
 * `fatal` は人が直すまで戻らない状態なので、何をすればよいかが出ていないと詰む。
 *
 * **画面側（oRPC）はこれを通らない。** あちらは `gatewayFatalHint` を
 * クライアントで引く —— 文言の出どころは同じ 1 か所なので、
 * 応答に載せるかどうかは口ごとに決めてよい（載せると `GatewayStatus` の
 * 出力検証に入らない値が 1 つ増える）。
 */
const gatewayResponse = (reply: GatewayReply): Response =>
  Response.json(
    { ...reply.body, hint: gatewayFatalHint(reply.body.fatalReason) },
    { status: reply.status },
  );

gateway.get("/status", async (c) =>
  gatewayResponse(await readGatewayStatus(c.env)),
);

gateway.post("/reset", async (c) => gatewayResponse(await resetGateway(c.env)));

/*
  **DO は自分では起動できない**（要件 `F-I2`）。alarm ごと evict された状態から
  戻す保険で、5 分 cron が叩く（P8）。**既に繋がっているなら何も起きない。**
*/
gateway.post("/ensure", async (c) =>
  gatewayResponse(await ensureGateway(c.env)),
);

app.route("/gateway", gateway);

/*
  Claude Code の hooks（要件 `F-D4`〜`F-D6`・計画 P5）。

  **Bearer 1 本で守る**（plans/security.md 脅威 2）。叩くのは cloud session の中の
  シェルスクリプトで、ブラウザからは来ないので `/gateway/*` のような
  「セッションでも通す」形にしない。

  **どの失敗も 204 で返す**（`handleHook*` の中）。hook は通報が届かなくても
  `exit 0` する best-effort の口で、**ここで 4xx を返しても誰も読まない** ——
  読むのは Cloudflare のログだけなので、そこに warn を残す方が役に立つ。
*/
const hooks = new Hono<AppBindings>();

hooks.use("*", async (c, next) => {
  if (!bearerMatches(c.req.header("authorization"), c.env.OFFDESK_TOKEN)) {
    console.warn("[hooks] bearer mismatch", { path: c.req.path });
    return c.text("unauthorized", 401);
  }
  await next();
});

hooks.post("/context", (c) => handleHookContext(c.req.raw, c.env));
hooks.post("/session-end", (c) => handleHookSessionEnd(c.req.raw, c.env));

app.route("/hooks", hooks);

/*
  実装計画の配布（要件 `F-E1`〜`F-E9`・計画 P6）。

  **置く口と読む口で守り方が違う。**

  - 置く（`/plans/*`）… Bearer ＋ `X-Offdesk-Run`。叩くのは cloud session の中の
    `publish-plan.sh` なので、hooks と同じ構え
  - 読む（`/p/*`）… **署名付きの期限付きリンク**（`plans/link.ts`）。`V-1` の結果で
    こちらに倒した（要件 §15 の未決 1）。判定は `handlePlanView` の中で行う ——
    ミドルウェアに出すと、署名を台帳より先に見るという順序（脅威 17）が
    2 か所に散る
*/
const plans = new Hono<AppBindings>();

plans.use("*", async (c, next) => {
  if (!bearerMatches(c.req.header("authorization"), c.env.OFFDESK_TOKEN)) {
    console.warn("[plans] bearer mismatch", { path: c.req.path });
    return c.text("unauthorized", 401);
  }
  await next();
});

/*
  **`finish` を先に置く。** Hono は登録順に見るので、`:path{.+}` を先に置くと
  `finish` という名前のファイルとして扱われる（拡張子が無いので 400 になり、
  症状は「計画が仕上がらない」）。メソッドが違う（POST / PUT）ので実際には
  衝突しないが、**順序に頼らない形にはできないので順序で守る。**
*/
plans.post("/:slug/finish", (c) =>
  handlePlanFinish(c.req.raw, c.env, { slug: c.req.param("slug") }),
);

plans.put("/:slug/:path{.+}", (c) =>
  handlePlanUpload(c.req.raw, c.env, {
    slug: c.req.param("slug"),
    path: c.req.param("path"),
  }),
);

app.route("/plans", plans);

/*
  **`/p/<32hex>` は `/p/<32hex>/` へ 301。** 末尾のスラッシュが無いと
  `./phase-01.md` が `/p/phase-01.md` に解決されて、計画の中の相対リンクが
  全部死ぬ（計画 P6 §4-4）。**クエリを付け直すのを忘れない** ——
  署名は `?t=` に載っているので、落とすとリダイレクト先で 401 になる。
*/
app.get("/p/:planId{[0-9a-f]{32}}", (c) => {
  const url = new URL(c.req.url);
  return c.redirect(`/p/${c.req.param("planId")}/${url.search}`, 301);
});

app.get("/p/:planId{[0-9a-f]{32}}/", (c) =>
  handlePlanView(c.req.raw, c.env, {
    planId: c.req.param("planId"),
    path: "",
  }),
);

app.get("/p/:planId{[0-9a-f]{32}}/:path{.+}", (c) =>
  handlePlanView(c.req.raw, c.env, {
    planId: c.req.param("planId"),
    path: c.req.param("path"),
  }),
);

app.post("/discord/interactions", async (c) => {
  const body = await c.req.text();
  const verdict = await verifyDiscordSignature({
    publicKey: c.env.DISCORD_PUBLIC_KEY,
    signature: c.req.header("x-signature-ed25519"),
    timestamp: c.req.header("x-signature-timestamp"),
    body,
  });

  if (verdict === "unconfigured") return c.text("not configured", 503);
  if (verdict === "invalid") return c.text("bad signature", 401);

  return await handleInteraction(JSON.parse(body), c.env, {
    waitUntil: (promise) => c.executionCtx.waitUntil(promise),
  });
});

app.use(`${RPC_PREFIX}/*`, async (c, next) => {
  const session = await createAuth(c.env).api.getSession({
    headers: c.req.raw.headers,
  });
  const { matched, response } = await rpc.handle(c.req.raw, {
    prefix: RPC_PREFIX,
    context: {
      session,
      env: c.env,
      waitUntil: (promise) => c.executionCtx.waitUntil(promise),
    },
  });
  return matched ? c.newResponse(response.body, response) : next();
});

const scheduled: ExportedHandlerScheduledHandler<WorkerEnv> = () => {};

export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<WorkerEnv>;

export { DiscordGatewayDO } from "./gateway/gateway.do.ts";
