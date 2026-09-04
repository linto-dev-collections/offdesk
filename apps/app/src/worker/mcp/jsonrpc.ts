export type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
  readonly jsonrpc?: string;
  readonly id?: JsonRpcId;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
};

export const PARSE_ERROR = -32700;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;

const jsonHeaders = { "content-type": "application/json" } as const;

export const rpcResult = (id: JsonRpcId, value: unknown): Response =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, result: value }), {
    headers: jsonHeaders,
  });

export const rpcError = (
  id: JsonRpcId,
  code: number,
  message: string,
): Response =>
  new Response(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }),
    {
      headers: jsonHeaders,
    },
  );

export const toolResultMessage = (
  id: JsonRpcId,
  text: string,
  isError = false,
): unknown => ({
  jsonrpc: "2.0",
  id,
  result: { content: [{ type: "text", text }], isError },
});

export const toolResult = (
  id: JsonRpcId,
  text: string,
  isError = false,
): Response =>
  new Response(JSON.stringify(toolResultMessage(id, text, isError)), {
    headers: jsonHeaders,
  });

export const toolStatus = (
  id: JsonRpcId,
  status: Readonly<Record<string, unknown>>,
  isError = false,
): unknown => toolResultMessage(id, JSON.stringify(status), isError);

export const toolStatusResult = (
  id: JsonRpcId,
  status: Readonly<Record<string, unknown>>,
  isError = false,
): Response =>
  new Response(JSON.stringify(toolStatus(id, status, isError)), {
    headers: jsonHeaders,
  });

/** 要求で渡された progress トークン。**無ければ progress 通知は送れない**（仕様）。 */
export const progressTokenOf = (
  params: Record<string, unknown>,
): string | number | null => {
  const meta = params._meta;
  if (typeof meta !== "object" || meta === null) return null;

  const token = (meta as Record<string, unknown>).progressToken;
  return typeof token === "string" || typeof token === "number" ? token : null;
};

export const progressNotification = (
  token: string | number,
  progress: number,
  message: string,
): unknown => ({
  jsonrpc: "2.0",
  method: "notifications/progress",
  // `progress` は毎回増える値でなければならない（仕様）。総数は分からないので `total` は載せない。
  params: { progressToken: token, progress, message },
});
