import { useSuspenseQuery } from "@tanstack/react-query";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { ProjectTable } from "../../components/project-table.tsx";
import { ErrorState, LoadingRows } from "../../components/states.tsx";
import { orpc } from "../../lib/orpc.ts";

const Projects = () => {
  const { data } = useSuspenseQuery(orpc.projects.list.queryOptions());

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="font-medium text-lg">プロジェクト</h1>
        {/*
          **「編集できません」を画面に書く**（計画 P7b §3-2）。
          できないことが分かるほうが、探して見つからないより良い ——
          代わりの手（`pnpm projects:sync`）を同じ行に置く。
        */}
        <p className="text-muted-foreground text-sm">
          この画面では編集できません。増やす・直すときは projects.json を書いて
          <code className="mx-1 rounded bg-muted px-1 py-0.5 text-xs">
            pnpm projects:sync
          </code>
          で投入してください。
        </p>
      </div>

      <ProjectTable items={data.items} />
    </div>
  );
};

const ProjectsError = ({ reset }: ErrorComponentProps) => {
  const router = useRouter();

  return (
    <ErrorState
      title="プロジェクトの一覧を読み込めませんでした"
      onRetry={() => {
        reset();
        void router.invalidate();
      }}
    />
  );
};

export const Route = createFileRoute("/_authed/projects")({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(orpc.projects.list.queryOptions()),
  component: Projects,
  pendingComponent: () => <LoadingRows rows={5} />,
  errorComponent: ProjectsError,
});
