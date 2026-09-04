import { RunListQuery } from "@offdesk/contract";
import { useSuspenseQuery } from "@tanstack/react-query";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { RunFilters } from "../../../components/run-filters.tsx";
import { RunPager } from "../../../components/run-pager.tsx";
import { RunTable } from "../../../components/run-table.tsx";
import { ErrorState, LoadingRows } from "../../../components/states.tsx";
import { orpc } from "../../../lib/orpc.ts";

const RunList = () => {
  /*
    **`Route.useSearch()` が返すのは検証済みの値**（`validateSearch`）。
    ここで `undefined` を捌く必要が無いのは、`RunListQuery` の全フィールドが
    `.catch()` か `.default()` を持っていて parse が失敗しないため。
  */
  const query = Route.useSearch();
  const navigate = Route.useNavigate();

  const { data } = useSuspenseQuery(
    orpc.runs.list.queryOptions({ input: query }),
  );
  const { data: projects } = useSuspenseQuery(
    orpc.projects.list.queryOptions(),
  );

  /*
    **絞り込みを変えたら 1 ページ目に戻す。** 戻さないと「3 ページ目のまま
    条件を絞って空の表が出る」——「該当なし」と見分けが付かない。
  */
  const patch = (next: Partial<RunListQuery>): void => {
    void navigate({ search: (prev) => ({ ...prev, ...next, page: 1 }) });
  };

  return (
    <div className="flex flex-col gap-4">
      <RunFilters
        query={query}
        projects={projects.items}
        onChange={patch}
        onReset={() => {
          // 空の search を渡すと `validateSearch` が既定値を入れ直す。
          void navigate({ search: {} });
        }}
      />
      <RunTable items={data.items} now={Date.now()} />
      <RunPager page={data.page} total={data.total} pageSize={data.pageSize} />
    </div>
  );
};

/**
 * 失敗（計画 P7a §3-5 の 3 状態）。
 *
 * **エラー境界を戻すだけでは足りない。** react-query が失敗を握っているので、
 * `router.invalidate()` で loader をもう 1 度走らせる。
 */
const RunListError = ({ reset }: ErrorComponentProps) => {
  const router = useRouter();

  return (
    <ErrorState
      title="run の一覧を読み込めませんでした"
      onRetry={() => {
        reset();
        void router.invalidate();
      }}
    />
  );
};

export const Route = createFileRoute("/_authed/runs/")({
  /*
    **契約の Zod をそのまま使う**（計画 P7a §3-4）。サーバーの入力検証と
    URL の検証が同じスキーマになるので、片方だけ緩い状態が作れない。
  */
  validateSearch: RunListQuery,
  loaderDeps: ({ search }) => search,
  loader: async ({ context, deps }) => {
    /*
      **プロジェクト一覧も先に取る。** 絞り込みの選択肢に要るので、
      loader に入れずに `useSuspenseQuery` だけで取ると、
      表が出た後に絞り込みだけが遅れて現れる。
    */
    await Promise.all([
      context.queryClient.ensureQueryData(
        orpc.runs.list.queryOptions({ input: deps }),
      ),
      context.queryClient.ensureQueryData(orpc.projects.list.queryOptions()),
    ]);
  },
  component: RunList,
  pendingComponent: () => <LoadingRows rows={8} />,
  errorComponent: RunListError,
});
