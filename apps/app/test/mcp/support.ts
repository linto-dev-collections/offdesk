import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import worker from "../../src/worker/index.ts";
import { ORIGIN } from "../discord/support.ts";

/*
  `/mcp` を叩くための道具。

  **握りは `waitUntil` の中で走るので、テストは「応答を受け取る」と
  「ストリームを読み切る」を分けて書く必要がある。** `readSse` を呼ぶまで pump は
  書き込みで詰まって止まっているだけなので、その間に D1 を触って答えを入れられる。
*/

export const MCP_TOKEN = "test-offdesk-token-0123456789abcdef";

export type McpCall = {
  readonly response: Response;
  readonly settle: () => Promise<void>;
};

/**
 * **「ヘッダを付けない」を `undefined` で表さない**（計画 README §2-3）。
 * 既定値つきの引数に `undefined` を渡すと既定値が入るので、
 * 「送っているのに 401 を期待する」テストが通ってしまう。`null` を割り当てる。
 */
export const mcpCall = async (
  body: unknown,
  overrides: {
    readonly authorization?: string | null;
    readonly env?: Partial<typeof env>;
    readonly method?: string;
    /** JSON にならない本文を送る（`-32700` の経路）。 */
    readonly rawBody?: string;
  } = {},
): Promise<McpCall> => {
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  });

  const authorization =
    overrides.authorization === undefined
      ? `Bearer ${MCP_TOKEN}`
      : overrides.authorization;
  if (authorization !== null) headers.set("authorization", authorization);

  const method = overrides.method ?? "POST";
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${ORIGIN}/mcp`, {
      method,
      headers,
      ...(method === "GET"
        ? {}
        : { body: overrides.rawBody ?? JSON.stringify(body) }),
    }),
    { ...env, ...overrides.env },
    ctx,
  );

  return { response, settle: () => waitOnExecutionContext(ctx) };
};

/** JSON で返る口（握らないもの）の本文。 */
export const mcpJson = async (
  body: unknown,
  overrides: Parameters<typeof mcpCall>[1] = {},
): Promise<{
  readonly body: Record<string, unknown>;
  readonly response: Response;
}> => {
  const { response, settle } = await mcpCall(body, overrides);
  const parsed = (await response.json()) as Record<string, unknown>;
  await settle();
  return { body: parsed, response };
};

/**
 * **1 個だけ読んで pump を歩かせ、ロックを返す。**
 *
 * `TransformStream` の readable 側の highWaterMark は 0 なので、
 * **読み手が来るまで最初の `write` すら解決しない**（P3b §9-3 で実測）。
 * これは設計として正しい —— 聞いていないクライアントのために Discord へ
 * 投稿したりはしない。
 *
 * **`releaseLock` が要点。** `getReader()` はストリームを固めるので、
 * 返さないと後で `readSse` も `body.cancel()` も
 * `This ReadableStream is currently locked to a reader` で落ちる。
 */
export const nudge = async (response: Response): Promise<void> => {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("SSE の本文がありません");
  await reader.read();
  reader.releaseLock();
};

export type SseFrames = {
  /** `data:` で流れてきた JSON-RPC メッセージ（progress 通知と応答の両方）。 */
  readonly messages: readonly Record<string, unknown>[];
  /** `: ` で始まるコメント行（沈黙を作らないためのもの。JSON-RPC ではない）。 */
  readonly comments: readonly string[];
};

/**
 * SSE を**閉じるまで**読み切る。握りは応答を送った後に自分で閉じるので、
 * これが返った時点で握りは終わっている。
 */
export const readSse = async (response: Response): Promise<SseFrames> => {
  const body = response.body;
  if (body === null) throw new Error("SSE の本文がありません");

  const messages: Record<string, unknown>[] = [];
  const comments: string[] = [];
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const drain = (): void => {
    for (;;) {
      const at = buffer.indexOf("\n\n");
      if (at === -1) return;
      const frame = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);

      for (const line of frame.split("\n")) {
        if (line.startsWith("data: ")) {
          messages.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
        } else if (line.startsWith(":")) {
          comments.push(line);
        }
      }
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    drain();
  }

  return { messages, comments };
};

/** 握りが最後に返した JSON-RPC 応答（progress 通知ではない方）。 */
export const finalResult = (
  frames: SseFrames,
): Record<string, unknown> | undefined =>
  [...frames.messages].reverse().find((message) => "result" in message);

export const progressNotifications = (
  frames: SseFrames,
): readonly Record<string, unknown>[] =>
  frames.messages.filter(
    (message) => message.method === "notifications/progress",
  );

/** ツールの戻り値のテキスト（1 個のテキストブロックしか返さない前提）。 */
export const toolText = (
  message: Record<string, unknown> | undefined,
): string => {
  const result = message?.result as
    | { content?: readonly { text?: string }[] }
    | undefined;
  return result?.content?.[0]?.text ?? "";
};

export const isToolError = (
  message: Record<string, unknown> | undefined,
): boolean =>
  (message?.result as { isError?: boolean } | undefined)?.isError === true;

/** `status` を持つ戻り値（`answered` / `pending` / `closed`）。 */
export const toolStatusOf = (
  message: Record<string, unknown> | undefined,
): Record<string, unknown> => {
  const text = toolText(message);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
};

export const askHumanCall = (input: {
  readonly runKey: string;
  readonly question?: unknown;
  readonly options?: unknown;
  readonly progressToken?: string | number;
  readonly id?: number;
}): unknown => ({
  jsonrpc: "2.0",
  id: input.id ?? 1,
  method: "tools/call",
  params: {
    name: "ask_human",
    arguments: {
      run_key: input.runKey,
      ...(input.question === undefined ? {} : { question: input.question }),
      ...(input.options === undefined ? {} : { options: input.options }),
    },
    ...(input.progressToken === undefined
      ? {}
      : { _meta: { progressToken: input.progressToken } }),
  },
});

/**
 * **観測できる状態になるまで待つ**（時間ではなく条件で待つ）。
 *
 * 要件 `N-9` が禁じているのは「一定時間眠って、経った長さを前提に断言する」形。
 * こちらは**条件が満たされた時点で進む**ので、速い機械でも遅い機械でも同じ結果になる
 * （満たされなければ上限で落ちる ＝ 黙って緑にならない）。
 *
 * 握りは `waitUntil` の中で走るので、**`mcpCall` が返った時点では pump が
 * `onOpen`（Discord への投稿）まで進んでいない。** 「投稿が済んでから接続を切る」を
 * 順序で書くには、この口が要る。
 */
export const waitUntilTrue = async (
  check: () => Promise<boolean>,
  label: string,
): Promise<void> => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  throw new Error(`条件が満たされませんでした: ${label}`);
};
