import { QueryClient } from "@tanstack/react-query";

/**
 * **再試行しない。** 401（未ログイン）は再試行しても 401 のままで、
 * ルートの gate が `/login` へ倒すまでの時間が伸びるだけになる。
 */
export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
