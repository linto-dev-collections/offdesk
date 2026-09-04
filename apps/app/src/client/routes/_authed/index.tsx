import {
  AlertCircleIcon,
  CheckmarkCircle02Icon,
  HelpCircleIcon,
  PlayIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  formatRelativeJst,
  type PendingAsk,
  type RunSummary,
} from "@offdesk/contract";
import { useSuspenseQuery } from "@tanstack/react-query";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/ui/card";
import type { ReactNode } from "react";
import { RunStatusBadge } from "../../components/run-status-badge.tsx";
import { ThreadLink } from "../../components/run-table.tsx";
import {
  EmptyState,
  ErrorState,
  LoadingRows,
} from "../../components/states.tsx";
import { orpc } from "../../lib/orpc.ts";

const SummaryCard = ({
  title,
  description,
  icon,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly icon: IconSvgElement;
  readonly children: ReactNode;
}) => (
  <Card>
    <CardHeader>
      <CardTitle className="flex items-center gap-2">
        <HugeiconsIcon
          icon={icon}
          strokeWidth={2}
          className="size-4 text-muted-foreground"
        />
        {title}
      </CardTitle>
      <CardDescription>{description}</CardDescription>
    </CardHeader>
    <CardContent className="flex flex-col gap-3">{children}</CardContent>
  </Card>
);

const RunRow = ({
  run,
  now,
}: {
  readonly run: RunSummary;
  readonly now: number;
}) => (
  <div className="flex flex-col gap-1 border-border border-b pb-3 last:border-b-0 last:pb-0">
    <div className="flex flex-wrap items-center gap-2">
      <RunStatusBadge status={run.status} />
      <span className="text-muted-foreground text-xs">{run.projectName}</span>
      <span className="text-muted-foreground text-xs">
        {formatRelativeJst(run.createdAt, now)}
      </span>
    </div>
    <Link
      to="/runs/$runKey"
      params={{ runKey: run.runKey }}
      className="break-words text-sm underline underline-offset-2"
    >
      {run.prompt}
      {run.promptTruncated ? "…" : ""}
    </Link>
  </div>
);

const AskRow = ({
  ask,
  now,
}: {
  readonly ask: PendingAsk;
  readonly now: number;
}) => (
  <div className="flex flex-col gap-1 border-border border-b pb-3 last:border-b-0 last:pb-0">
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-muted-foreground text-xs">{ask.projectName}</span>
      <span className="text-muted-foreground text-xs">
        {formatRelativeJst(ask.createdAt, now)}
      </span>
      {ask.optionCount === 0 ? null : (
        <span className="text-muted-foreground text-xs">
          選択肢 {ask.optionCount}
        </span>
      )}
      {/*
        **これがいちばん気づきにくい詰まり**（`asks.message_id` が NULL）。
        問いは立っているのに Discord に出ていないので、待っている側からは
        「Claude が黙っている」に見える。
      */}
      {ask.postedToDiscord ? null : (
        <span className="text-destructive text-xs">Discord 未送信</span>
      )}
    </div>
    <Link
      to="/runs/$runKey"
      params={{ runKey: ask.runKey }}
      className="break-words text-sm underline underline-offset-2"
    >
      {ask.question}
    </Link>
    <ThreadLink url={ask.threadUrl} children="スレッドで答える" />
  </div>
);

const Dashboard = () => {
  const { data } = useSuspenseQuery(orpc.dashboard.summary.queryOptions());
  const now = Date.now();

  return (
    <div className="grid auto-rows-min gap-4 md:grid-cols-3">
      <SummaryCard
        title="走っている run"
        description="queued / running / waiting を新しい順に 10 件"
        icon={PlayIcon}
      >
        {data.liveRuns.length === 0 ? (
          <EmptyState
            icon={CheckmarkCircle02Icon}
            title="走っている run はありません"
          />
        ) : (
          data.liveRuns.map((run) => (
            <RunRow key={run.runKey} run={run} now={now} />
          ))
        )}
        <Link
          to="/runs"
          search={{ status: "running" }}
          className="text-xs underline underline-offset-2"
        >
          run の一覧へ
        </Link>
      </SummaryCard>

      <SummaryCard
        title="未回答の ask"
        description="答えがまだ入っていない質問を新しい順に 10 件"
        icon={HelpCircleIcon}
      >
        {data.pendingAsks.length === 0 ? (
          <EmptyState
            icon={CheckmarkCircle02Icon}
            title="未回答の ask はありません"
          />
        ) : (
          data.pendingAsks.map((ask) => (
            <AskRow key={ask.askId} ask={ask} now={now} />
          ))
        )}
      </SummaryCard>

      <SummaryCard
        title="直近の失敗"
        description="failed / abandoned を新しい順に 5 件"
        icon={AlertCircleIcon}
      >
        {data.recentFailures.length === 0 ? (
          <EmptyState
            icon={CheckmarkCircle02Icon}
            title="直近の失敗はありません"
          />
        ) : (
          data.recentFailures.map((run) => (
            <RunRow key={run.runKey} run={run} now={now} />
          ))
        )}
        <Link
          to="/runs"
          search={{ status: "failed" }}
          className="text-xs underline underline-offset-2"
        >
          失敗した run を絞り込む
        </Link>
      </SummaryCard>
    </div>
  );
};

const DashboardError = ({ reset }: ErrorComponentProps) => {
  const router = useRouter();

  return (
    <ErrorState
      title="ダッシュボードを読み込めませんでした"
      onRetry={() => {
        reset();
        void router.invalidate();
      }}
    />
  );
};

export const Route = createFileRoute("/_authed/")({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(orpc.dashboard.summary.queryOptions()),
  component: Dashboard,
  pendingComponent: () => <LoadingRows rows={6} />,
  errorComponent: DashboardError,
});
