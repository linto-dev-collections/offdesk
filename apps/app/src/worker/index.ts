import { createAuth } from "@offdesk/auth";
import { HealthOutput, RPC_PREFIX } from "@offdesk/contract";
import { getHealth } from "@offdesk/usecase";
import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";
import { admin } from "./admin/projects.ts";
import { handleInteraction } from "./discord/interactions.ts";
import { verifyDiscordSignature } from "./discord/verify.ts";
import { type AppBindings, assertEnv, type WorkerEnv } from "./env.ts";
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
