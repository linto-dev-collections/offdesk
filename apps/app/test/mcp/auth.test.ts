import { describe, expect, it } from "vitest";
import { MCP_TOKEN, mcpCall } from "./support.ts";

/*
  plans/security.md 脅威 2・16。**`/mcp` は Bearer 1 本で守る。**

  ここで固めたいのは 2 つ:

    1. 未設定なら誰も通らない（要件 `I-2`。空文字どうしが一致して全開になる形を作らない）
    2. **握る前に検査している** —— 401 の応答が `text/event-stream` ではないこと。
       先にストリームを開いてから検査すると、その時点で資源を使っている（脅威 16）。
*/

const PING = { jsonrpc: "2.0", id: 1, method: "ping" };

describe("POST /mcp の Bearer", () => {
  it("正しいトークンで通る", async () => {
    const { response, settle } = await mcpCall(PING);
    await settle();

    expect(response.status).toBe(200);
  });

  it("1 文字違いで 401", async () => {
    const { response, settle } = await mcpCall(PING, {
      authorization: `Bearer ${MCP_TOKEN.slice(0, -1)}X`,
    });
    await settle();

    expect(response.status).toBe(401);
  });

  it("長さが違うだけでも 401", async () => {
    const { response, settle } = await mcpCall(PING, {
      authorization: `Bearer ${MCP_TOKEN}x`,
    });
    await settle();

    expect(response.status).toBe(401);
  });

  /*
    **`OFFDESK_TOKEN` が未設定なら誰も通らない**（要件 `I-2`）。
    空文字どうしを一致させると口が全開になる。
  */
  it.each(["", "   "])(
    "OFFDESK_TOKEN が未設定（%s）なら正しいトークンでも通らない",
    async (configured) => {
      const { response, settle } = await mcpCall(PING, {
        env: { OFFDESK_TOKEN: configured },
      });
      await settle();

      expect(response.status).toBe(401);
    },
  );

  it("OFFDESK_TOKEN が未設定なら空の Bearer でも通らない", async () => {
    const { response, settle } = await mcpCall(PING, {
      authorization: "Bearer ",
      env: { OFFDESK_TOKEN: "" },
    });
    await settle();

    expect(response.status).toBe(401);
  });

  it("Authorization ヘッダが無いと 401", async () => {
    // **`null` が「付けない」。** `undefined` だと既定値（正しいトークン）が入る。
    const { response, settle } = await mcpCall(PING, { authorization: null });
    await settle();

    expect(response.status).toBe(401);
  });

  it.each([
    ["Bearer が無い", MCP_TOKEN],
    ["別のスキーム", `Bot ${MCP_TOKEN}`],
    ["小文字の bearer", `bearer ${MCP_TOKEN}`],
    ["Bearer だけ", "Bearer"],
  ])("%s は 401", async (_label, header) => {
    const { response, settle } = await mcpCall(PING, { authorization: header });
    await settle();

    expect(response.status).toBe(401);
  });

  it("前後に空白を付けた値でも通る（Bearer の後ろは trim する）", async () => {
    const { response, settle } = await mcpCall(PING, {
      authorization: `Bearer  ${MCP_TOKEN} `,
    });
    await settle();

    expect(response.status).toBe(200);
  });

  /*
    **握る前に検査している証拠。** ストリームを開いてから弾くと、この応答は
    `text/event-stream` になる（そして開いた分の資源は既に使っている）。
  */
  it("401 はストリームではない", async () => {
    const { response, settle } = await mcpCall(PING, { authorization: null });
    await settle();

    expect(response.headers.get("content-type")).not.toContain(
      "text/event-stream",
    );
    expect(await response.text()).toBe("unauthorized");
  });
});
