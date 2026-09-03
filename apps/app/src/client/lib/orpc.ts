import type { contract } from "@offdesk/contract";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";

/**
 * サーバー実装ではなく**契約から**クライアントの型を起こす（要件 `I-8`）。
 *
 * `ContractRouterClient<typeof contract>` を通すので、`packages/contract` を
 * 変えないかぎりクライアントの型は動かない。サーバーの実装型に依存させると、
 * `apps/app/src/worker` への import が要るようになって
 * `client-no-worker`（plans/security.md 脅威 4）に触る。
 */
const link = new RPCLink({
  url: "/rpc",
  // **同一オリジンでも `credentials` を明示する。** 既定は `same-origin` なので
  // 実際には飛ぶが、明示していないと「Cookie が飛ばない」を疑う手間が毎回発生する。
  fetch: (request) => fetch(request, { credentials: "include" }),
});

const client: ContractRouterClient<typeof contract> = createORPCClient(link);

export const orpc = createTanstackQueryUtils(client);
