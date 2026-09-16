export type JsonRpcId = string | number | null;

/**
 * POST の本文に来うるもの。**要求だけではない。**
 *
 * Streamable HTTP は「要求 / 通知 / 応答のいずれか 1 つ」を本文に許していて、
 * 通知と応答には `202 Accepted` を**本文なしで**返すことが MUST。
 * 3 つを見分けるために `result` / `error` の有無まで型に入れてある。
 */
export type JsonRpcMessage = {
  readonly jsonrpc?: string;
  readonly id?: JsonRpcId;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: unknown;
  readonly error?: unknown;
};

export const JSONRPC_VERSION = "2.0";

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;

/**
 * 初期化のあと、クライアントが**すべての要求に載せる**ヘッダ（`2025-06-18` 以降）。
 *
 * **無ければ `2025-03-26` とみなす**のが仕様の後方互換規定で、
 * **知らない値・対応していない値なら `400` を返すのが MUST。**
 * https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
 */
export const MCP_PROTOCOL_VERSION_HEADER = "mcp-protocol-version";

/**
 * ヘッダが無いときに仮定する版（仕様の後方互換規定）。
 *
 * **`PROTOCOL_VERSIONS` に必ず含まれている値であること。** 含まれていないと、
 * ヘッダを送らない古いクライアントが 400 で弾かれる。
 */
export const ASSUMED_PROTOCOL_VERSION = "2025-03-26";

/**
 * 本文が 3 つのどれか（あるいはどれでもないか）。
 *
 * **`response` を `method` が無い要求として扱わない**のが要点。あれを
 * `-32601`（未対応のメソッド）で返すと、クライアントは「自分の送った応答に
 * サーバーが応答を返した」という無限に往復できる形を受け取る。
 */
export type JsonRpcShape = "request" | "notification" | "response" | "invalid";

export const jsonRpcShapeOf = (body: JsonRpcMessage): JsonRpcShape => {
  const hasId = body.id !== undefined && body.id !== null;

  if (typeof body.method === "string" && body.method !== "") {
    return hasId ? "request" : "notification";
  }

  // `method` が無い ＝ 要求ではない。応答なら `id` ＋ `result` か `error` を持つ。
  if (hasId && ("result" in body || "error" in body)) return "response";

  return "invalid";
};

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
  new Response(
    JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, result: value }),
    {
      headers: jsonHeaders,
    },
  );

export const rpcError = (
  id: JsonRpcId,
  code: number,
  message: string,
  options: { readonly data?: unknown; readonly status?: number } = {},
): Response =>
  new Response(
    JSON.stringify({
      jsonrpc: JSONRPC_VERSION,
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
  jsonrpc: JSONRPC_VERSION,
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
  jsonrpc: JSONRPC_VERSION,
  method: "notifications/progress",
  // `progress` は毎回増える値でなければならない（仕様）。総数は分からないので `total` は載せない。
  params: { progressToken: token, progress, message },
});
