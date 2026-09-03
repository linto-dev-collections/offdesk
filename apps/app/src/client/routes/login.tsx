import { authClient } from "@offdesk/auth/client";
import { safeRedirectPath } from "@offdesk/contract";
import { createFileRoute } from "@tanstack/react-router";
import { LoginForm } from "@workspace/ui/components/block/login-form";

const Login = () => {
  const { redirect } = Route.useSearch();

  const signIn = (): void => {
    void authClient.signIn.social({
      provider: "google",
      callbackURL: safeRedirectPath(redirect),
    });
  };

  return (
    <div className="flex min-h-svh w-full items-center justify-center p-6 md:p-10">
      <div className="w-full max-w-sm">
        <LoginForm onSignIn={signIn} />
      </div>
    </div>
  );
};

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>) => ({
    redirect: typeof search.redirect === "string" ? search.redirect : undefined,
  }),
  component: Login,
});
