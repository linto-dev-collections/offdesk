import { createAuth } from "@offdesk/auth";
import { HealthOutput, RPC_PREFIX } from "@offdesk/contract";
import { getHealth } from "@offdesk/usecase";
import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";
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
