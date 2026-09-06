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

/**
 * `UnsupportedProtocolVersionError`（MCP 仕様の予約域）。
 *
 * **`2026-07-28`（modern）のクライアントに版を選び直させるための 1 個。**
 * 詳しくは `server.ts` の `unsupportedProtocolVersion`。
 */
export const UNSUPPORTED_PROTOCOL_VERSION = -32022;

/**
 * 要求が名乗っている版の在り処（`2026-07-28`）。
 *
 * modern のクライアントは**すべての要求**にこの `_meta` を載せ、同じ値を
 * `MCP-Protocol-Version` ヘッダにも入れる。offdesk は legacy（`initialize` で
 * 交渉する世代）しか話さないので、**読むのは「modern が来た」の判定のためだけ。**
 */
export const MODERN_PROTOCOL_VERSION_KEY =
  "io.modelcontextprotocol/protocolVersion";

const jsonHeaders = { "content-type": "application/json" } as const;

export const rpcResult = (id: JsonRpcId, value: unknown): Response =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, result: value }), {
    headers: jsonHeaders,
  });

export const rpcError = (
  id: JsonRpcId,
  code: number,
  message: string,
  options: { readonly data?: unknown; readonly status?: number } = {},
): Response =>
  new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: {
        code,
        message,
        ...(options.data === undefined ? {} : { data: options.data }),
      },
    }),
    {
      status: options.status ?? 200,
      headers: jsonHeaders,
    },
  );

/**
 * その要求が **modern（`2026-07-28` 以降）の作法で来ているか**、来ているなら何版か。
 *
 * modern は「毎回の要求が版を名乗り、サーバーが 1 件ずつ受け入れるか断る」形で、
 * `initialize` のハンドシェイクが無い。**ヘッダだけでは判定しない** ——
 * legacy のクライアントも `2025-06-18` 以降は `MCP-Protocol-Version` を送るので、
 * ヘッダを根拠にすると**いま通っている経路を落とす**。
 * modern は `_meta` とヘッダの両方を必ず載せる（片方だけは仕様違反）ので、
 * **`_meta` の側を根拠にする。**
 */
export const modernProtocolVersion = (
  params: Record<string, unknown> | undefined,
): string | null => {
  const meta = params?._meta;
  if (typeof meta !== "object" || meta === null) return null;

  const version = (meta as Record<string, unknown>)[
    MODERN_PROTOCOL_VERSION_KEY
  ];
  return typeof version === "string" && version !== "" ? version : null;
};

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
