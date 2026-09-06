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

describe("modern（2026-07-28）の要求", () => {
  const modern = (method: string, version: string): unknown => ({
    jsonrpc: "2.0",
    id: 3,
    method,
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": version,
        "io.modelcontextprotocol/clientInfo": { name: "v2", version: "0.0.0" },
      },
    },
  });

  it.each(["server/discover", "tools/list", "initialize"])(
    "%s が 400 ＋ -32022 で、話せる版を並べる",
    async (method) => {
      const { response, settle } = await mcpCall(modern(method, "2026-07-28"));
      const body = (await response.json()) as Record<string, unknown>;
      await settle();

      expect(response.status).toBe(400);
      expect(body).toMatchObject({
        id: 3,
        error: {
          code: -32022,
          data: {
            supported: ["2025-11-25", "2025-06-18", "2025-03-26"],
            requested: "2026-07-28",
          },
        },
      });
    },
  );

  it("server/discover は _meta が無くても -32022", async () => {
    const { response, settle } = await mcpCall({
      jsonrpc: "2.0",
      id: 3,
      method: "server/discover",
    });
    const body = (await response.json()) as Record<string, unknown>;
    await settle();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ error: { code: -32022 } });
  });

  it("名乗った版が話せるものなら普通に応える", async () => {
    const { body } = await mcpJson(modern("ping", "2025-11-25"));

    expect(body).toEqual({ jsonrpc: "2.0", id: 3, result: {} });
  });

  it("_meta が無ければ、知らないメソッドは今までどおり 200 ＋ -32601", async () => {
    const { body, response } = await mcpJson({
      jsonrpc: "2.0",
      id: 7,
      method: "resources/list",
    });

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ error: { code: -32601 } });
  });
});

describe("Origin の検査（DNS リバインディング）", () => {
  it("別オリジンからは 403", async () => {
    const { response, settle } = await mcpCall(
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { origin: "https://evil.example" },
    );
    await settle();

    expect(response.status).toBe(403);
  });

  it("Origin が無ければ通る（機械の口の既定）", async () => {
    const { body } = await mcpJson({ jsonrpc: "2.0", id: 1, method: "ping" });

    expect(body.result).toEqual({});
  });

  /** **認証より先に落とす**ので、トークンが正しくても別オリジンなら 403。 */
  it("正しい Bearer でも別オリジンなら 403", async () => {
    const { response, settle } = await mcpCall(
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { origin: "https://evil.example" },
    );
    await settle();

    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("token");
  });
});

describe("tools/list", () => {
  it("3 つ返す（ask_wait と report は中身が無くても一覧に出す）", async () => {
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

  it("ask_human の引数が run_key / question / options で、必須は前の 2 つ", async () => {
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
    /*
      **`options` は `required` に入れない**（P3b で外した）。

      P3a では入れていたが、**それだと `(再送)` の呼び直しが表現できない** ——
      あちらは `question` の 1 語だけで呼ぶ契約なので、スキーマが `options` を
      要求するとクライアントが送れない形になる。

      **「選択肢が無い問いを作らない」という判断は変えていない。** 場所が移っただけで、
      `validateAsk` が**新しい問いを立てる経路だけ**で要求する（`ask.test.ts` が見る）。
    */
    expect(askHuman?.inputSchema.required).toEqual(["run_key", "question"]);
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

  /*
    **3 つとも中身が入った**（P3b）。引数が足りないときは
    「呼び方が正しいのに結果が出せない」なので `isError`（プロトコルのエラーにしない）。
  */
  it.each([
    ["ask_wait", "ask_id"],
    ["report", "run_key"],
  ])("%s は引数が足りないと isError で返す", async (name) => {
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
    expect(result.content[0]?.text).not.toContain("まだ使えません");
  });

  it.each(["ask_wait", "report"])(
    "%s の説明が「まだ使えない」と言わない",
    async (name) => {
      // P3a はここに「まだ使えない」と書いていた。**残すと Claude が呼ばなくなる。**
      const { body } = await mcpJson({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      });
      const tools = (
        body.result as {
          tools: readonly { name: string; description: string }[];
        }
      ).tools;

      expect(
        tools.find((tool) => tool.name === name)?.description,
      ).not.toContain("まだ使えない");
    },
  );
});
