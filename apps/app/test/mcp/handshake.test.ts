import { SERVER_INSTRUCTIONS } from "@offdesk/domain";
import { describe, expect, it } from "vitest";
import { mcpCall, mcpJson } from "./support.ts";

const initialize = (protocolVersion?: string): unknown => ({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    ...(protocolVersion === undefined ? {} : { protocolVersion }),
    capabilities: {},
    clientInfo: { name: "test-client", version: "0.0.0" },
  },
});

describe("initialize", () => {
  it("要求された版を持っていればそれを返す", async () => {
    const { body } = await mcpJson(initialize("2025-06-18"));

    expect(body.result).toMatchObject({ protocolVersion: "2025-06-18" });
  });

  it("知らない版を要求されたら、こちらの最新を返す", async () => {
    const { body } = await mcpJson(initialize("1900-01-01"));

    expect(body.result).toMatchObject({ protocolVersion: "2025-11-25" });
  });

  it("版が無くても落ちない", async () => {
    const { body } = await mcpJson(initialize());

    expect(body.result).toMatchObject({ protocolVersion: "2025-11-25" });
  });

  it("tools の capability を名乗る", async () => {
    const { body } = await mcpJson(initialize("2025-11-25"));
    const result = body.result as Record<string, unknown>;

    expect(result.capabilities).toEqual({ tools: {} });
    expect(result.serverInfo).toMatchObject({ name: "offdesk" });
  });

  /*
    **握りが落ちたときの契約を、サーバー自身が毎回名乗る**（計画 P3a §3-4・要件 §9-1）。
    ここが載っていれば、routine 側への貼り忘れで契約が壊れない。
  */
  it("instructions に SERVER_INSTRUCTIONS が入る", async () => {
    const { body } = await mcpJson(initialize("2025-11-25"));
    const result = body.result as { instructions?: string };

    expect(result.instructions).toBe(SERVER_INSTRUCTIONS);
  });

  it("instructions が run_key の語彙で書かれている", async () => {
    // **`session_key` と書かない**（テーブル定義書 §2 の語彙）。
    expect(SERVER_INSTRUCTIONS).toContain("run_key");
    expect(SERVER_INSTRUCTIONS).not.toContain("session_key");
  });

  it("instructions が「待ってもトークンを消費しない」を名乗る", async () => {
    // これが無いと Claude が待つのを惜しみ、勝手に決めて先へ進む（要件 `F-B1` の眼目）。
    expect(SERVER_INSTRUCTIONS).toContain("トークンは消費しません");
  });
});

describe("tools/list", () => {
  it("3 つ返す（ask_wait と report は中身が無くても一覧に出す）", async () => {
    /*
      **一覧に出しておくのは routine の `allowed_tools` を後から増やさないため**
      （あれはコードの外にあるので、増やし忘れると承認待ちで固まる。要件 §9-1）。
    */
    const { body } = await mcpJson({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const tools = (body.result as { tools: readonly { name: string }[] }).tools;

    expect(tools.map((tool) => tool.name)).toEqual([
      "ask_human",
      "ask_wait",
      "report",
    ]);
  });

  it("ask_human の引数が run_key / question / options で、3 つとも必須", async () => {
    const { body } = await mcpJson({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const tools = (
      body.result as {
        tools: readonly {
          name: string;
          inputSchema: {
            properties: Record<string, unknown>;
            required: string[];
          };
        }[];
      }
    ).tools;
    const askHuman = tools.find((tool) => tool.name === "ask_human");

    expect(Object.keys(askHuman?.inputSchema.properties ?? {})).toEqual([
      "run_key",
      "question",
      "options",
    ]);
    // **P3a では options も必須**（答える口がボタンだけなので、無いと誰も答えられない）。
    expect(askHuman?.inputSchema.required).toEqual([
      "run_key",
      "question",
      "options",
    ]);
  });

  it("説明文に session_key と書かない", async () => {
    const { body } = await mcpJson({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });

    expect(JSON.stringify(body.result)).not.toContain("session_key");
  });
});

describe("そのほかのメソッド", () => {
  it("ping は空の result を返す", async () => {
    const { body } = await mcpJson({ jsonrpc: "2.0", id: 1, method: "ping" });

    expect(body).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });

  it("notifications/initialized は 202 で本文が無い", async () => {
    const { response, settle } = await mcpCall({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    await settle();

    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  it("知らないメソッドは -32601", async () => {
    const { body } = await mcpJson({
      jsonrpc: "2.0",
      id: 7,
      method: "resources/list",
    });

    expect(body).toMatchObject({ id: 7, error: { code: -32601 } });
  });

  it("id が 0 でもそのまま返す", async () => {
    // `body.id ?? null` が 0 を null に落とすと、クライアントが応答を紐付けられない。
    const { body } = await mcpJson({ jsonrpc: "2.0", id: 0, method: "ping" });

    expect(body.id).toBe(0);
  });

  it("JSON として読めない本文は -32700", async () => {
    const { response, settle } = await mcpCall(null, {
      rawBody: "{ これは JSON ではない",
    });
    const body = (await response.json()) as Record<string, unknown>;
    await settle();

    // **id が分からないので null で返す**（仕様の parse error）。
    expect(body).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "JSON として読めません" },
    });
  });

  it("method が無い要求はプロトコルのエラーで返す（落ちない）", async () => {
    const { body } = await mcpJson({ jsonrpc: "2.0", id: 9 });

    expect(body).toMatchObject({ id: 9, error: { code: -32601 } });
  });

  it("GET /mcp は 405", async () => {
    // **サーバーから話しかける口を持たない**（仕様が 405 を許している）。
    const { response, settle } = await mcpCall(null, { method: "GET" });
    await settle();

    expect(response.status).toBe(405);
  });
});

describe("tools/call の知らないツール", () => {
  it("-32601 を返す（isError ではない）", async () => {
    /*
      **呼び方の誤りはプロトコルのエラー**（仕様 server/tools「Error Handling」）。
      `isError` にすると Claude が「結果」として読んで同じ呼び方を続ける。
    */
    const { body } = await mcpJson({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "ask_robot", arguments: {} },
    });

    expect(body).toMatchObject({ error: { code: -32601 } });
    expect(body.result).toBeUndefined();
  });

  it.each(["ask_wait", "report"])(
    "%s は「まだ使えません」を isError で返す",
    async (name) => {
      // 一覧には出すが中身は無い（P3b で入る）。**プロトコルのエラーにしない** ——
      // 呼び方は正しいので、Claude には文面を読んで別の手を採ってほしい。
      const { body } = await mcpJson({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: {} },
      });
      const result = body.result as {
        isError: boolean;
        content: readonly { text: string }[];
      };

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("まだ使えません");
    },
  );
});
