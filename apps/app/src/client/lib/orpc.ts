import { type contract, rpcUrl } from "@offdesk/contract";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";

const link = new RPCLink({
  url: rpcUrl(window.location.origin),
  fetch: (request, init) => fetch(request, { ...init, credentials: "include" }),
});

const client: ContractRouterClient<typeof contract> = createORPCClient(link);

export const orpc = createTanstackQueryUtils(client);
