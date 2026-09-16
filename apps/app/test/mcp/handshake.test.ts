import {
  MCP_INSTRUCTIONS_BUDGET,
  MCP_TEXT_LIMIT,
  SERVER_INSTRUCTIONS,
} from "@offdesk/domain";
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

/*
  **切られたことは誰にも通知されない**（2026-09-16 に見張りを足した）。

  Claude Code は server instructions と各 tool description を **2048 文字**で切り、
  `…[truncated]` を付けて捨てる（`instructions.length <= 2048` の素の比較。
  2.1.273 のバンドルで実測）。**バイト数ではないので日本語でも 1 文字 1。**

  超えた日に起きるのは「説明の途中で切れた文章が Claude に渡る」で、
  症状は**ツールの使い方を守らない**という読みにくい形になる。
  上限ちょうどではなく余白（`MCP_INSTRUCTIONS_BUDGET`）で止める。
  https://code.claude.com/docs/en/mcp
*/
describe("2048 文字で切られる文章（MCP の上限）", () => {
  it("上限より予算の方が小さい", () => {
    expect(MCP_INSTRUCTIONS_BUDGET).toBeLessThan(MCP_TEXT_LIMIT);
  });

  it("SERVER_INSTRUCTIONS が予算に収まる", () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(
      MCP_INSTRUCTIONS_BUDGET,
    );
  });

  /** 各ツールの説明も**1 本ずつ**同じ長さで切られる。 */
  it("tool description が全部上限に収まる", async () => {
    const { body } = await mcpJson({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const tools = (
      body.result as { tools: readonly { name: string; description: string }[] }
    ).tools;

    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect([tool.name, tool.description.length <= MCP_TEXT_LIMIT]).toEqual([
        tool.name,
        true,
      ]);
    }
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

/*
  `MCP-Protocol-Version` ヘッダ（`2025-06-18` 以降。2026-09-16 に足した）。

  クライアントは初期化のあと**すべての要求に**このヘッダを載せ、
  仕様は「知らない値・対応していない値なら `400`」を MUST と定めている。
  **無いのは正常**（`2025-03-26` とみなす後方互換規定）。
  https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
*/
describe("MCP-Protocol-Version ヘッダ", () => {
  const ping = { jsonrpc: "2.0", id: 1, method: "ping" };

  it.each(["2025-11-25", "2025-06-18", "2025-03-26"])(
    "話せる版（%s）なら通る",
    async (protocolVersion) => {
      const { body } = await mcpJson(ping, { protocolVersion });

      expect(body.result).toEqual({});
    },
  );

  it("ヘッダが無ければ通る（2025-03-26 とみなす）", async () => {
    const { body } = await mcpJson(ping);

    expect(body.result).toEqual({});
  });

  it.each(["2026-07-28", "2024-11-05", "not-a-date"])(
    "話せない版（%s）は 400 ＋ -32022 で話せる版を並べる",
    async (protocolVersion) => {
      const { body, response } = await mcpJson(ping, { protocolVersion });

      expect(response.status).toBe(400);
      expect(body).toMatchObject({
        error: {
          code: -32022,
          data: {
            supported: ["2025-11-25", "2025-06-18", "2025-03-26"],
            requested: protocolVersion,
          },
        },
      });
    },
  );

  /*
    **`initialize` も同じ扱い。** 交渉の前だからと免除すると、
    ヘッダと本文で別の版を名乗る要求がそのまま通る。
  */
  it("initialize でも話せない版のヘッダは 400", async () => {
    const { response } = await mcpJson(initialize("2025-11-25"), {
      protocolVersion: "2026-07-28",
    });

    expect(response.status).toBe(400);
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

  /*
    **`ask_human` だけが常時ロードを名乗る**（`_meta` の `anthropic/alwaysLoad`）。

    遅延ロードされた `ask_human` は「ツールが 1 本も無い」と**症状が同じ（無音）**で、
    OPERATIONS §10 が切り分けの表を 1 行使って書いている取り違えそのもの。
    `.mcp.json` の `alwaysLoad` はクライアント側の設定なので、
    書き忘れた経路が 1 つあれば同じ穴が開く —— サーバー側からも言う。

    **残り 2 本には付けない。** 常時ロードは文脈を食うので、「無いと詰む」1 本だけ。
  */
  it("ask_human だけが _meta で常時ロードを名乗る", async () => {
    const { body } = await mcpJson({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const tools = (
      body.result as {
        tools: readonly {
          name: string;
          _meta?: Record<string, unknown>;
        }[];
      }
    ).tools;

    expect(
      tools
        .filter((tool) => tool._meta?.["anthropic/alwaysLoad"] === true)
        .map((tool) => tool.name),
    ).toEqual(["ask_human"]);
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

  /*
    **要求・通知・応答のどれでもない本文**（`method` も `result` も `error` も無い）。

    2026-09-16 まで `-32601`（未対応のメソッド）で返していたが、
    **これは「メソッドを知らない」ではなく「要求になっていない」** ——
    仕様は受け取れない入力に HTTP のエラー（400）を返すと定めている。
  */
  it("要求の形になっていない本文は 400 ＋ -32600", async () => {
    const { body, response } = await mcpJson({ jsonrpc: "2.0", id: 9 });

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ id: 9, error: { code: -32600 } });
  });

  /*
    **クライアントからの応答は `202`**（仕様の MUST）。

    握りは progress 通知を流すので、相手が応答を返してくることがある。
    以前は `method` が無いだけで `-32601` を返していた ——
    相手から見れば「自分の送った応答にサーバーが応答した」という
    終わりの無い形になる。
  */
  it.each([
    ["result を持つ応答", { jsonrpc: "2.0", id: 4, result: {} }],
    ["error を持つ応答", { jsonrpc: "2.0", id: 4, error: { code: -1 } }],
  ])("%s は 202 で本文が無い", async (_label, message) => {
    const { response, settle } = await mcpCall(message);
    await settle();

    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  /** `notifications/` 以外の名前でも、`id` が無ければ通知（仕様）。 */
  it("id の無いメソッド呼び出しは 202", async () => {
    const { response, settle } = await mcpCall({
      jsonrpc: "2.0",
      method: "ping",
    });
    await settle();

    expect(response.status).toBe(202);
  });

  /*
    **`jsonrpc` は `"2.0"` ちょうど**（JSON-RPC 2.0）。
    見ずに通すと 1.0 の本文（`id` ＋ `method` だけ）を 2.0 の要求として処理する。
  */
  it.each([
    ["1.0 を名乗る", { jsonrpc: "1.0", id: 1, method: "ping" }],
    ["名乗らない", { id: 1, method: "ping" }],
  ])("%s 本文は 400 ＋ -32600", async (_label, message) => {
    const { body, response } = await mcpJson(message);

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ error: { code: -32600 } });
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
