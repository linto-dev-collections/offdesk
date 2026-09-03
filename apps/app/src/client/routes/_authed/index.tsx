import { authClient } from "@offdesk/auth/client";
import { formatJst } from "@offdesk/contract";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import { orpc } from "../../lib/orpc.ts";

/*
  ダッシュボードの枠（P7a で中身が入る）。

  `useSuspenseQuery` を使えるのは `_authed` の gate が同じキーで先に取ってあるため
  （`beforeLoad` の `query()`）。**gate を外すとここが読み込み中で止まる**ので、
  gate とこのクエリは対で動く。
*/

/**
 * ログアウト。
 *
 * **`authClient.signOut()` を使う。** `/api/auth/sign-out` は **POST 専用**なので、
 * `window.location.href` で開くと GET になり **404** になる（P1 §9-9 で踏んだ）。
 * 認証の口は URL を手書きせず、必ず `authClient` を通す。
 *
 * **SPA 遷移ではなく全体を読み直す。** gate の `staleTime` は 5 分なので、
 * SPA 遷移だとキャッシュに残った `me`（200）で**セッションが無いのに
 * gate が通ってしまう。** 全体を読み直せばメモリ上の状態が全部消えるので、
 * 「何を消し忘れたか」を考えなくてよい——ログアウトの意味にも合っている。
 */
const signOut = (): void => {
  void authClient.signOut().finally(() => {
    window.location.assign("/login");
  });
};

const Dashboard = () => {
  const { data: me } = useSuspenseQuery(orpc.me.queryOptions());

  return (
    <div className="flex min-h-svh flex-col gap-6 p-6">
      <header className="flex items-center justify-between gap-4">
        <h1 className="font-medium">offdesk</h1>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-muted-foreground">{me.email}</span>
          <Button size="sm" variant="outline" onClick={signOut}>
            ログアウト
          </Button>
        </div>
      </header>
      <p className="text-muted-foreground text-sm">
        骨格だけの状態です（P1）。run の一覧は P7a で入ります。
      </p>
      <p className="font-mono text-muted-foreground text-xs">
        {formatJst(Date.now())}
      </p>
    </div>
  );
};

export const Route = createFileRoute("/_authed/")({
  component: Dashboard,
});
