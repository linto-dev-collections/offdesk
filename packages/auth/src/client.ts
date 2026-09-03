import { createAuthClient } from "better-auth/client";

/**
 * ブラウザ側の認証クライアント。**このファイルだけが `apps/app/src/client` から
 * import できる**（`.dependency-cruiser.cjs` の `client-no-auth-server`）。
 *
 * `better-auth/react` ではなく `better-auth/client` を使うのは、`useSession` を
 * 使わないため。セッションの有無は `/rpc/me`（TanStack Query）で見るので、
 * ここに React を持ち込むと状態の出所が 2 つになる。
 *
 * `baseURL` を渡さないので現在のオリジンを使う。SPA と API が同一オリジンなので
 * これが正しく、**環境ごとに値を注ぐ必要がない**（クライアントに環境変数を渡さない
 * という約束が保てる。plans/security.md 脅威 4）。
 */
export const authClient = createAuthClient();
