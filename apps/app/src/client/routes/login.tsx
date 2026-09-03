import { authClient } from "@offdesk/auth/client";
import { safeRedirectPath } from "@offdesk/contract";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";

/*
  ログイン画面（要件 F-G1）。**Google のボタン 1 つだけ。**
  パスワードもメールリンクも持たない。

  `_authed` の gate が `redirect` に元の場所を入れて飛ばしてくる。
  **その値は `safeRedirectPath` を通してから使う**（plans/security.md 脅威 10）。
  素で `callbackURL` に渡すと、`/login?redirect=//evil.example.com` で
  外部サイトへ飛ばせる。
*/
const Login = () => {
  const { redirect } = Route.useSearch();

  const signIn = () => {
    void authClient.signIn.social({
      provider: "google",
      callbackURL: safeRedirectPath(redirect),
    });
  };

  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col gap-1">
          <h1 className="font-medium text-lg">offdesk</h1>
          <p className="text-muted-foreground text-sm">
            許可されたアカウントだけが入れます。
          </p>
        </div>
        <Button onClick={signIn}>Google でログイン</Button>
      </div>
    </div>
  );
};

export const Route = createFileRoute("/login")({
  // 未知のクエリで画面が落ちないように、`redirect` 以外は捨てる。
  validateSearch: (search: Record<string, unknown>) => ({
    redirect: typeof search.redirect === "string" ? search.redirect : undefined,
  }),
  component: Login,
});
