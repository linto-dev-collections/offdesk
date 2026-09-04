import { contract } from "@offdesk/contract";
import { createDb, listProjectsWithMask } from "@offdesk/db";
import { listProjectSummaries } from "@offdesk/usecase";
import { implement, ORPCError } from "@orpc/server";
import { removePlan } from "../plans/routes.ts";
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
  plans: {
    remove: authed.plans.remove.handler(async ({ context, input }) => ({
      removed: await removePlan(context.env, input.planId),
    })),
  },
  projects: {
    list: authed.projects.list.handler(async ({ context }) => {
      const db = createDb(context.env.DB);
      const items = await listProjectSummaries({
        listWithMask: () => listProjectsWithMask(db),
      });
      return { items: [...items] };
    }),
  },
});
