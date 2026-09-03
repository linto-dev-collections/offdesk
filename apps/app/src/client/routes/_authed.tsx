import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { orpc } from "../lib/orpc.ts";

/*
  **ログインの判定はここ 1 か所だけ。** 認証が要る画面は全部この下に置く
  （P7a の run 一覧・詳細もここへ）。

  `__root.tsx` に置かない理由: root は `/login` も包むので、root で飛ばすと
  ログイン画面自身が `/login` へ飛び続ける。

  `ensureQueryData` にしているのは、**gate で引いた結果を画面が引き直さないため**
  （同じキーのキャッシュに載るのでリクエストは 1 回）。
*/
export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ context, location }) => {
    try {
      await context.queryClient.ensureQueryData(orpc.me.queryOptions());
    } catch {
      // 401 も通信エラーもここへ来る。**どちらもログイン画面へ倒す**
      // （「入れないのに入れたように見える」より、入り直せる方がよい）。
      throw redirect({
        to: "/login",
        search: { redirect: location.href },
      });
    }
  },
  component: () => <Outlet />,
});
