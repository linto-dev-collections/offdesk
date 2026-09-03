import { env } from "cloudflare:workers";
import { MeOutput } from "@offdesk/contract";
import { describe, expect, it } from "vitest";
import worker from "../../src/worker/index.ts";
import { OWNER_NAME, signIn } from "../auth/support.ts";

const ORIGIN = "http://localhost:5173";

const callMe = async (headers: Headers = new Headers()): Promise<Response> => {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("content-type", "application/json");
  requestHeaders.set("origin", ORIGIN);
  return await worker.fetch(
    new Request(`${ORIGIN}/rpc/me`, {
      method: "POST",
      headers: requestHeaders,
      body: "{}",
    }),
    env,
  );
};

describe("POST /rpc/me", () => {
  /*
    **未ログインは 401。** `authed` ミドルウェアが `ORPCError("UNAUTHORIZED")` を
    投げる。ここが 200 を返したら、P7a 以降の画面 API 全部が素通しになる。
  */
  it("未ログインなら 401", async () => {
    const response = await callMe();

    expect(response.status).toBe(401);
  });

  it("ログイン中ならメールを返す", async () => {
    const { headers, email } = await signIn();

    const response = await callMe(headers);

    expect(response.status).toBe(200);
    const body = await response.json<{ json?: unknown }>();
    // oRPC は本文を包むので、契約が通る形になっているかを parse で見る。
    const payload = body.json ?? body;
    expect(MeOutput.parse(payload)).toEqual({
      email,
      name: OWNER_NAME,
      imageUrl: null,
    });
  });

  /*
    **`imageUrl` が `null` で返ること。** `undefined` を返す実装だと JSON から
    キーが消え、出力検証（契約の `.output()`）が「画像なし」と「付け忘れ」を
    区別できなくなる。
  */
  it("画像が無いとき imageUrl は null（キーが消えない）", async () => {
    const { headers } = await signIn();

    const response = await callMe(headers);
    const body = await response.json<{ json?: Record<string, unknown> }>();
    const payload = body.json ?? body;

    expect(payload).toHaveProperty("imageUrl", null);
  });
});

describe("/rpc の外は oRPC が飲み込まない", () => {
  it("契約に無い名前は 404", async () => {
    const response = await worker.fetch(
      new Request(`${ORIGIN}/rpc/does-not-exist`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: "{}",
      }),
      env,
    );

    expect(response.status).toBe(404);
  });
});
