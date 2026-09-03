import { env } from "cloudflare:workers";
import { createAuth } from "@offdesk/auth";
import { describe, expect, it } from "vitest";
import { signIn } from "./support.ts";

/*
  Cookie とセッション（要件 `F-G6`・plans/security.md 脅威 5）。

  属性は**実物の応答の `Set-Cookie` から読む。** 設定オブジェクトを覗くと、
  Better Auth が設定をどう解釈したかを見ないことになる。
*/

/** OAuth を始めさせて state Cookie を吐かせ、その `Set-Cookie` を読む。 */
const setCookieOf = async (overrides: Parameters<typeof createAuth>[0]) => {
  const auth = createAuth(overrides);
  const baseUrl = overrides.BETTER_AUTH_URL;
  const response = await auth.handler(
    new Request(`${baseUrl}/api/auth/sign-in/social`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: baseUrl,
        "cf-connecting-ip": "10.0.0.1",
      },
      body: JSON.stringify({ provider: "google", callbackURL: "/" }),
    }),
  );
  return { response, cookies: response.headers.getAll("set-cookie") };
};

describe("Cookie の属性", () => {
  it("HttpOnly と SameSite=Lax が付く", async () => {
    const { cookies } = await setCookieOf(env);

    expect(cookies.length).toBeGreaterThan(0);
    for (const cookie of cookies) {
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
    }
  });

  it("http では Secure を付けない（localhost で Cookie が捨てられる）", async () => {
    const { cookies } = await setCookieOf(env);

    for (const cookie of cookies) {
      expect(cookie).not.toMatch(/Secure/i);
    }
  });

  /*
    **本番（https）では Secure が付く。** `useSecureCookies` は
    `BETTER_AUTH_URL` が https かどうかで決めているので、URL を変えて確かめる。
  */
  it("https では Secure が付く", async () => {
    const { cookies } = await setCookieOf({
      ...env,
      BETTER_AUTH_URL: "https://offdesk.linto-dev.workers.dev",
    });

    expect(cookies.length).toBeGreaterThan(0);
    for (const cookie of cookies) {
      expect(cookie).toMatch(/Secure/i);
    }
  });

  it("Cookie 名に offdesk の接頭辞が付く", async () => {
    const { cookies } = await setCookieOf(env);

    expect(cookies.join(" ")).toContain("offdesk");
  });
});

describe("Google が設定されている", () => {
  it("sign-in/social が Google の認可画面へ向ける URL を返す", async () => {
    const { response } = await setCookieOf(env);
    const body = await response.json<{ url?: string }>();

    expect(response.status).toBe(200);
    expect(body.url).toContain("accounts.google.com");
    expect(body.url).toContain("test-google-client-id");
  });
});

describe("レートリミット", () => {
  /*
    **`cf-connecting-ip` を見ていること。** 指定しないと Better Auth は
    `x-forwarded-for` を探し、Workers には届かないので**全利用者が 1 つの
    バケットを共有する**（1 回の失敗で全員が 60 秒締め出される）。
  */
  it("ipAddressHeaders が cf-connecting-ip になっている", async () => {
    const options = (await createAuth(env).$context).options;

    expect(options.advanced?.ipAddress?.ipAddressHeaders).toEqual([
      "cf-connecting-ip",
    ]);
  });

  /*
    **`disableCSRFCheck` と `disableOriginCheck` に触らない。** 既定（false）が正しい。
    渡した options の literal 型にこの 2 つが無いので `tsc` も保証しているが、
    実行時にも見るために型を広げて読む。
  */
  it("CSRF と Origin の検査を無効にしていない", async () => {
    const advanced: Record<string, unknown> = (await createAuth(env).$context)
      .options.advanced;

    expect(advanced.disableCSRFCheck).toBeUndefined();
    expect(advanced.disableOriginCheck).toBeUndefined();
  });
});

describe("セッションが解決できる", () => {
  it("署名した Cookie から getSession がユーザーを返す", async () => {
    const { headers, email } = await signIn();

    const session = await createAuth(env).api.getSession({ headers });

    expect(session?.user.email).toBe(email);
  });

  it("Cookie が無ければ null", async () => {
    const session = await createAuth(env).api.getSession({
      headers: new Headers(),
    });

    expect(session).toBeNull();
  });

  it("署名が壊れていれば null", async () => {
    const { headers } = await signIn();
    const broken = new Headers();
    broken.set("cookie", `${headers.get("cookie")}tampered`);

    const session = await createAuth(env).api.getSession({ headers: broken });

    expect(session).toBeNull();
  });
});
