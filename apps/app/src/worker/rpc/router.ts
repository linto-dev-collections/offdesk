import { contract } from "@offdesk/contract";
import { implement, ORPCError } from "@orpc/server";
import type { RpcContext } from "./context.ts";

const os = implement(contract).$context<RpcContext>();

const authed = os.use(({ context, next }) => {
  if (context.session === null) throw new ORPCError("UNAUTHORIZED");
  return next({ context: { ...context, session: context.session } });
});

export const router = os.router({
  me: authed.me.handler(({ context }) => ({
    email: context.session.user.email,
    name: context.session.user.name,
    imageUrl: context.session.user.image ?? null,
  })),
});
