import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../../src/worker/index.ts";
import { signIn, testIp } from "./support.ts";

// /api/auth/sign-out は POST 専用。window.location.href で開くと GET になり
// 404 になる（P1 §9-9）。GET が 200 に変われば CSRF の口なので、そのときも見直す。
const ORIGIN = "http://localhost:5173";

const signOut = async (
  method: "GET" | "POST",
  headers: Headers,
): Promise<Response> => {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("origin", ORIGIN);
  requestHeaders.set("cf-connecting-ip", testIp(`sign-out/${method}`));
  if (method === "POST") requestHeaders.set("content-type", "application/json");

  return await worker.fetch(
    new Request(`${ORIGIN}/api/auth/sign-out`, {
      method,
      headers: requestHeaders,
      body: method === "POST" ? "{}" : null,
    }),
    env,
  );
};

const sessionCount = async (): Promise<number> => {
  const row = await env.DB.prepare("SELECT count(*) AS n FROM sessions").first<{
    n: number;
  }>();
  return row?.n ?? 0;
};

describe("POST /api/auth/sign-out", () => {
  it("セッションつきで 200 を返す", async () => {
    const { headers } = await signIn();

    expect((await signOut("POST", headers)).status).toBe(200);
  });

  // Cookie を消すだけだと、同じトークンを控えた別端末でまだ入れる。
  it("sessions の行が消える", async () => {
    const { headers } = await signIn();
    expect(await sessionCount()).toBe(1);

    await signOut("POST", headers);

    expect(await sessionCount()).toBe(0);
  });

  it("ログアウト後は /rpc/me が 401", async () => {
    const { headers } = await signIn();
    await signOut("POST", headers);

    const response = await worker.fetch(
      new Request(`${ORIGIN}/rpc/me`, {
        method: "POST",
        headers: (() => {
          const h = new Headers(headers);
          h.set("content-type", "application/json");
          h.set("origin", ORIGIN);
          h.set("cf-connecting-ip", testIp("sign-out/me"));
          return h;
        })(),
        body: "{}",
      }),
      env,
    );

    expect(response.status).toBe(401);
  });
});

describe("GET /api/auth/sign-out", () => {
  it("404 を返す（POST でしかログアウトできない）", async () => {
    const { headers } = await signIn();

    expect((await signOut("GET", headers)).status).toBe(404);
  });

  it("GET ではセッションが消えない", async () => {
    const { headers } = await signIn();

    await signOut("GET", headers);

    expect(await sessionCount()).toBe(1);
  });
});
