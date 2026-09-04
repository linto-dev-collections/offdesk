import { createAuth } from "@offdesk/auth";
import { HealthOutput, RPC_PREFIX } from "@offdesk/contract";
import { bearerMatches } from "@offdesk/domain";
import { getHealth } from "@offdesk/usecase";
import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";
import { admin } from "./admin/projects.ts";
import { handleInteraction } from "./discord/interactions.ts";
import { verifyDiscordSignature } from "./discord/verify.ts";
import { type AppBindings, assertEnv, type WorkerEnv } from "./env.ts";
import { handleMcp } from "./mcp/server.ts";
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
