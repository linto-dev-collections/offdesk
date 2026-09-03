import { contract } from "@offdesk/contract";
import { implement, ORPCError } from "@orpc/server";
import type { RpcContext } from "./context.ts";

const os = implement(contract).$context<RpcContext>();

/**
 * ログイン必須の入口。**各手続きで認証をやり直さない。**
 *
 * `next({ context })` でセッションを絞り込んで渡すので、この下の手続きでは `context.session` が `null` になりえない。
 */
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
