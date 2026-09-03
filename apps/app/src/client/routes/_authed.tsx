import { SESSION_CACHE_SECONDS } from "@offdesk/contract";
import { ORPCError } from "@orpc/client";
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { orpc } from "../lib/orpc.ts";

// 401 以外を /login に倒すと、壊れたクライアントが「未ログイン」に見えて
// 原因の分からない無限ループになる（P1 §9-7）。
const isUnauthorized = (error: unknown): boolean =>
  error instanceof ORPCError && error.status === 401;

export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ context, location }) => {
    try {
      // staleTime はサーバーの cookieCache と同じ値。"static" にすると
      // タブを開いたままセッションが切れたとき gate が通す（P1 §9-8）。
      await context.queryClient.query({
        ...orpc.me.queryOptions(),
        staleTime: SESSION_CACHE_SECONDS * 1000,
      });
    } catch (error) {
      if (!isUnauthorized(error)) throw error;
      throw redirect({ to: "/login", search: { redirect: location.href } });
    }
  },
  component: () => <Outlet />,
});
