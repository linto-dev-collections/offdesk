import type { QueryClient } from "@tanstack/react-query";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import { queryClient } from "../lib/query.ts";

/**
 * `queryClient` を文脈に持たせるのは、**`beforeLoad` からクエリを引くため**
 * （`_authed.tsx` の gate）。コンポーネントの外なので hooks が使えない。
 */
export type RouterContext = {
  queryClient: QueryClient;
};

export const Route = createRootRouteWithContext<RouterContext>()({
  component: () => (
    <QueryClientProvider client={queryClient}>
      <Outlet />
    </QueryClientProvider>
  ),
});
