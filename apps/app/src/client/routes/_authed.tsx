import { SESSION_CACHE_SECONDS } from "@offdesk/contract";
import { ORPCError } from "@orpc/client";
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { orpc } from "../lib/orpc.ts";

const isUnauthorized = (error: unknown): boolean =>
  error instanceof ORPCError && error.status === 401;

export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ context, location }) => {
    try {
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
