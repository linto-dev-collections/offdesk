/*
  JSON-RPC 2.0 の封筒だけ（計画 P3a §3-1）。

  **公式 SDK を使わない理由は「SSE の 1 バイト目から制御が要る」こと**なので、
  自前で書くのはこの封筒と `hold.ts` のストリームに限る。ここに業務の判断を置かない。

  MCP は 2 通りのエラーを持つ（仕様 server/tools「Error Handling」）:

    プロトコルの誤り  JSON-RPC の `error`   知らないメソッド・知らないツール・引数の型
    ツールの失敗      `result.isError: true`  業務上ありうる失敗（run が無い・問いが空）

  **取り違えると Claude が回復できない。** `error` は「呼び方が間違っている」の合図なので、
  Claude は同じ呼び方を諦める。`isError` は結果なので、Claude は文面を読んで直せる。
*/

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

/**
 * ツールの戻り値（1 個のテキストブロック）。
 *
 * **握りは同じ形を SSE の `data:` に載せる**ので、メッセージの組み立てと
 * HTTP 応答への包み方を分けてある。
 */
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

/**
 * 機械が読む戻り値（`status` を持つ JSON）を 1 個のテキストブロックに載せる。
 *
 * **`structuredContent` を使わない。** あれは `outputSchema` を宣言した口の話で、
 * 宣言すると「サーバーはスキーマに従う結果を返さねばならない」（仕様）。
 * 握りは `answered` / `pending` / エラーで形が変わるので、宣言しない側に倒す。
 */
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
