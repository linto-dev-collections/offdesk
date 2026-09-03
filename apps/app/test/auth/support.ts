import { env } from "cloudflare:workers";

/*
  ログインの UI を踏まずにセッションを作る。

  **行を直接入れる。** Better Auth の `internalAdapter.createUser` は
  リクエストの周囲の文脈（`getCurrentAuthEndpointContext()`）を要求するので、
  テストから呼べない（1.7.2 で実測: `User validation requires an endpoint context`）。
  `createOAuthUser` は文脈が要らないが dist のどこからも呼ばれていない死んだ口なので、
  そこに依存するのも避ける。

  Cookie は**Better Auth と同じ形**（`値.HMAC-SHA256 の base64`）で署名する。
  こうすると `getSession` は本物の経路（Cookie → 署名検証 → D1）を通るので、
  配線が壊れればテストが落ちる。

  **`better-auth` を直接 import しない。** あれは `packages/auth` の依存で、
  `apps/app` に足すと **client からサーバー側の SDK へ到達する経路**ができ、
  `client-no-auth-server` が守っている境界を回り込める。
*/

/** テストで使う持ち主のメール。`vitest.config.ts` の allowlist と揃えてある。 */
export const OWNER_EMAIL = "offdesk.me@gmail.com";
export const OWNER_NAME = "offdesk owner";

const SESSION_LIFETIME_MS = 60 * 60 * 1000;

/** `better-auth/crypto` の `makeSignature` と同じ。向こうが変えたらここが落ちる。 */
const signValue = async (value: string, secret: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  );
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
};

/** ログイン済みの Cookie を持つ `Headers` を返す。 */
export const signIn = async (
  options: Readonly<{ email?: string; name?: string }> = {},
): Promise<Readonly<{ headers: Headers; email: string; userId: string }>> => {
  const email = options.email ?? OWNER_EMAIL;
  const name = options.name ?? OWNER_NAME;
  const userId = crypto.randomUUID();
  const token = crypto.randomUUID();
  const now = Date.now();

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?,?,?,1,?,?)",
    ).bind(userId, name, email, now, now),
    env.DB.prepare(
      "INSERT INTO sessions (id, token, user_id, expires_at, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    ).bind(
      crypto.randomUUID(),
      token,
      userId,
      now + SESSION_LIFETIME_MS,
      now,
      now,
    ),
  ]);

  const signed = `${token}.${await signValue(token, env.BETTER_AUTH_SECRET)}`;
  const headers = new Headers();
  // Cookie 名は `advanced.cookiePrefix` と Better Auth の既定から決まる。
  headers.set("cookie", `offdesk.session_token=${signed}`);

  return { headers, email, userId };
};

/** `users` の行数。「拒否したメールの行が残らない」を見るのに使う。 */
export const countUsers = async (): Promise<number> => {
  const row = await env.DB.prepare("SELECT count(*) AS n FROM users").first<{
    n: number;
  }>();
  return row?.n ?? 0;
};
