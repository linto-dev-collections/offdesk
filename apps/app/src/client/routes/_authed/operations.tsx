import { isDefinedError } from "@orpc/client";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/ui/card";
import { useEffect, useState } from "react";
import { GatewayPanel } from "../../components/gateway-panel.tsx";
import { ErrorState, LoadingRows } from "../../components/states.tsx";
import { orpc } from "../../lib/orpc.ts";

/**
 * 状態を引き直す間隔。
 *
 * **張り直した直後は `connecting`。** そこから `live` へ移るのは 1〜2 秒なので、
 * 引き直さないと「押したのに接続中のまま」に見える —— この画面を開いている
 * 間だけの間隔で、DO への要求は 1 分に 12 回（常駐している DO なので
 * duration は増えない）。
 *
 * **`refetchIntervalInBackground` は既定の false のまま。** 開いたまま
 * 放置したタブが叩き続けるのを避ける。
 */
const STATUS_POLL_MS = 5_000;

/** 残り時間の表示に要る時計。**1 秒ごと**（`あと N 秒` が飛ばずに減る）。 */
const TICK_MS = 1_000;

const useNow = (): number => {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  return now;
};

const Operations = () => {
  const queryClient = useQueryClient();
  const now = useNow();
  const { data: status } = useSuspenseQuery(
    orpc.gateway.status.queryOptions({ refetchInterval: STATUS_POLL_MS }),
  );
  const [notice, setNotice] = useState<string | null>(null);

  const reset = useMutation(
    orpc.gateway.reset.mutationOptions({
      onSuccess: (output) => {
        setNotice(null);
        queryClient.setQueryData(orpc.gateway.status.queryKey(), output);
      },
      onError: (error) => {
        /*
          **429 の本文にも状態が乗っている**（契約の `.errors()`）。
          そのまま差し込めば、断られた画面がそのまま残り時間を出せる ——
          もう 1 回 `status` を叩き直す必要がない。
        */
        if (isDefinedError(error) && error.code === "TOO_MANY_REQUESTS") {
          queryClient.setQueryData(orpc.gateway.status.queryKey(), error.data);
          setNotice("張り直しは 60 秒に 1 回までです。");
          return;
        }

        // **理由の文字列を出さない**（脅威 12）。種別だけを見せる。
        setNotice(
          "張り直せませんでした。しばらくしてからもう一度試してください。",
        );
      },
    }),
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="font-medium text-lg">運用</h1>
        <p className="text-muted-foreground text-sm">
          Discord の Gateway
          は素の文（スレッドの発言）を受け取る唯一の経路です。ここが止まると、
          run に文が届かなくなります。
        </p>
      </div>

      {notice === null ? null : (
        <p className="rounded-md bg-muted px-3 py-2 text-sm">{notice}</p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Discord Gateway</CardTitle>
          <CardDescription>
            {/*
              **これが画面から state を変える唯一の操作**（要件 `F-F4`）——
              もう 1 つは計画の取り消し。
            */}
            状態の表示と張り直し。offdesk の画面で状態を変えられるのは、これと
            計画の取り消しだけです。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <GatewayPanel
            status={status}
            now={now}
            resetPending={reset.isPending}
            onReset={() => reset.mutate({})}
          />
        </CardContent>
      </Card>
    </div>
  );
};

const OperationsError = ({ reset }: ErrorComponentProps) => {
  const router = useRouter();

  return (
    <ErrorState
      title="Gateway の状態を読み込めませんでした"
      onRetry={() => {
        reset();
        void router.invalidate();
      }}
    />
  );
};

export const Route = createFileRoute("/_authed/operations")({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(orpc.gateway.status.queryOptions()),
  component: Operations,
  pendingComponent: () => <LoadingRows rows={4} />,
  errorComponent: OperationsError,
});
