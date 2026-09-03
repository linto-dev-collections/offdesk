import { formatJst } from "@offdesk/contract";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import { orpc } from "../../lib/orpc.ts";

/*
  ダッシュボードの枠（P7a で中身が入る）。

  `useSuspenseQuery` を使えるのは `_authed` の gate が `ensureQueryData` で
  先に取ってあるため。**gate を外すとここが読み込み中で止まる**ので、
  gate とこのクエリは対で動く。
*/
const Dashboard = () => {
  const { data: me } = useSuspenseQuery(orpc.me.queryOptions());

  return (
    <div className="flex min-h-svh flex-col gap-6 p-6">
      <header className="flex items-center justify-between gap-4">
        <h1 className="font-medium">offdesk</h1>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-muted-foreground">{me.email}</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              window.location.href = "/api/auth/sign-out";
            }}
          >
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
