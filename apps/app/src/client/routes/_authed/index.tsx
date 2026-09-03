import { authClient } from "@offdesk/auth/client";
import { formatJst } from "@offdesk/contract";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import { orpc } from "../../lib/orpc.ts";

// 認証の口は URL を手書きせず authClient を通す（sign-out は POST 専用。P1 §9-9）。
// 全体を読み直すのは、gate の staleTime 5 分ぶんキャッシュに残った me で
// セッションが無いのに通ってしまうのを防ぐため。
// .then() なのは、失敗したログアウトを成功に見せないため（signOut は throw する）。
const signOut = (): void => {
  void authClient.signOut().then(() => {
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
