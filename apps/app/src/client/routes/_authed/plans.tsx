import type { PlanSummary } from "@offdesk/contract";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { ConfirmDialog } from "../../components/confirm-dialog.tsx";
import { PlanTable } from "../../components/plan-table.tsx";
import { ErrorState, LoadingRows } from "../../components/states.tsx";
import { orpc } from "../../lib/orpc.ts";

const Plans = () => {
  const queryClient = useQueryClient();
  const { data } = useSuspenseQuery(orpc.plans.list.queryOptions());
  const [target, setTarget] = useState<PlanSummary | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const remove = useMutation(
    orpc.plans.remove.mutationOptions({
      onSuccess: async (output) => {
        /*
          **`removed: false` を成功として黙らせない**（計画 P7b §5 の
          「黙って成功しない」）。返るのは 200 だが、消すものが無かった
          ＝ 一覧が古い、なので**引き直して**そう言う。
        */
        setNotice(
          output.removed
            ? null
            : "その計画は既にありません（一覧を読み直しました）",
        );
        setTarget(null);
        await queryClient.invalidateQueries({ queryKey: orpc.plans.key() });
      },
    }),
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="font-medium text-lg">計画</h1>
        <p className="text-muted-foreground text-sm">
          cloud session から置かれた実装計画。取り消すと戻せません。
        </p>
      </div>

      {notice === null ? null : (
        <p className="rounded-md bg-muted px-3 py-2 text-sm">{notice}</p>
      )}

      <PlanTable
        items={data.items}
        now={Date.now()}
        onRemove={(plan) => {
          setNotice(null);
          setTarget(plan);
        }}
      />

      <ConfirmDialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
        title="この計画を取り消しますか"
        description={
          target === null
            ? ""
            : `${target.slug}（${target.fileCount} ファイル）を消します。R2 のファイルも URL も消え、戻せません。`
        }
        confirmLabel="取り消す"
        pending={remove.isPending}
        onConfirm={() => {
          if (target === null) return;
          remove.mutate({ planId: target.planId });
        }}
      />
    </div>
  );
};

const PlansError = ({ reset }: ErrorComponentProps) => {
  const router = useRouter();

  return (
    <ErrorState
      title="計画の一覧を読み込めませんでした"
      onRetry={() => {
        reset();
        void router.invalidate();
      }}
    />
  );
};

export const Route = createFileRoute("/_authed/plans")({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(orpc.plans.list.queryOptions()),
  component: Plans,
  pendingComponent: () => <LoadingRows rows={6} />,
  errorComponent: PlansError,
});
