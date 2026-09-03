/**
 * セッションの状態をどれだけ古いまま信じるか（秒）。
 *
 * **client と worker が同じ値を見る**のが要点。
 *
 * | 使う場所 | 何に使うか |
 * | --- | --- |
 * | `packages/auth` | Better Auth の `session.cookieCache.maxAge`。この間は D1 を引かずに署名付き Cookie を信じる |
 * | `apps/app/src/client/routes/_authed.tsx` | ログイン判定の `staleTime`。この間は再確認しない |
 *
 * **`staleTime: "static"` にしない。** あれは「永久に再取得しない」なので、
 * タブを開いたままセッションが切れたとき、gate が通してしまう。
 * サーバーが 5 分より細かく知らないなら、client も 5 分より細かく主張しない
 * ——**両側を同じ粒度に揃える**のがここの目的。
 */
export const SESSION_CACHE_SECONDS = 60 * 5;
