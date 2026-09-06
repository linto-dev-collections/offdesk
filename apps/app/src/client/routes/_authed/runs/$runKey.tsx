import { LinkSquare02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { formatJst, formatRelativeJst } from "@offdesk/contract";
import { useSuspenseQuery } from "@tanstack/react-query";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/ui/card";
import { ContextBar } from "../../../components/context-bar.tsx";
import { RunStatusBadge } from "../../../components/run-status-badge.tsx";
import { ErrorState, LoadingRows } from "../../../components/states.tsx";
import { Timeline } from "../../../components/timeline.tsx";
import { orpc } from "../../../lib/orpc.ts";

const OutLink = ({
  href,
  children,
}: {
  readonly href: string;
  readonly children: string;
}) => (
  <a
    href={href}
    target="_blank"
    rel="noreferrer"
    className="inline-flex items-center gap-1 text-sm underline underline-offset-2"
  >
    <HugeiconsIcon
      icon={LinkSquare02Icon}
      strokeWidth={2}
      className="size-3.5"
    />
    {children}
  </a>
);

const Field = ({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) => (
  <div className="flex flex-col gap-0.5">
    <span className="text-muted-foreground text-xs">{label}</span>
    <div className="text-sm">{children}</div>
  </div>
);

const RunDetail = () => {
  const { runKey } = Route.useParams();
  const { data: run } = useSuspenseQuery(
    orpc.runs.detail.queryOptions({ input: { runKey } }),
  );
  const now = Date.now();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <RunStatusBadge status={run.status} />
        <h1 className="font-medium text-lg tabular-nums">{run.runKey}</h1>
        <Link
          to="/runs"
          search={{ projectId: run.projectId }}
          className="text-sm underline underline-offset-2"
        >
          {run.projectName}
        </Link>
        {/*
          **`thread_id` / `cc_session_url` が NULL なら出さない**（完了条件）。
          スレッドは `DISCORD_GUILD_ID` が未設定のときも `null` になる。
        */}
        {run.threadUrl === null ? null : (
          <OutLink href={run.threadUrl}>スレッドを開く</OutLink>
        )}
        {run.ccSessionUrl === null ? null : (
          <OutLink href={run.ccSessionUrl}>cloud session を開く</OutLink>
        )}
        <OutLink href={run.repoUrl}>リポジトリ</OutLink>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>依頼</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {/* 詳細は全文（調査に要る）。一覧が 120 字なのはそちらの都合。 */}
          <p className="whitespace-pre-wrap break-words text-sm">
            {run.prompt}
          </p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="開始">
              {formatJst(run.createdAt)}
              <span className="ms-2 text-muted-foreground text-xs">
                {formatRelativeJst(run.createdAt, now)}
              </span>
            </Field>
            <Field label="終了">
              {run.finishedAt === null ? (
                <span className="text-muted-foreground">
                  まだ終わっていません
                </span>
              ) : (
                formatJst(run.finishedAt)
              )}
            </Field>
            <Field label="コンテキスト使用量">
              <ContextBar
                percent={run.contextPercent}
                usedTokens={run.contextUsedTokens}
                windowTokens={run.contextWindowTokens}
                windowKnown={run.contextWindowKnown}
              />
              {run.contextAt === null ? null : (
                <span className="text-muted-foreground text-xs">
                  {formatRelativeJst(run.contextAt, now)}の通報
                  {run.contextModel === null ? "" : `・${run.contextModel}`}
                </span>
              )}
            </Field>
            <Field label="依頼者">
              <span className="tabular-nums">{run.requesterDiscordUserId}</span>
            </Field>
            {/*
              **`held_at` と `activity_at` は別の意味**（テーブル定義書 §4-3）。
              握りが生きているか（短い窓）と Claude が息をしているか（長い窓）で、
              詰まりの切り分けはこの 2 つの差を見るのがいちばん速い。
            */}
            <Field label="握りの最終ハートビート">
              {run.heldAt === null ? (
                <span className="text-muted-foreground">なし</span>
              ) : (
                formatRelativeJst(run.heldAt, now)
              )}
            </Field>
            <Field label="Claude の最終信号">
              {run.activityAt === null ? (
                <span className="text-muted-foreground">なし</span>
              ) : (
                formatRelativeJst(run.activityAt, now)
              )}
            </Field>
          </div>
          {run.failureReason === null ? null : (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-destructive text-sm">
              {run.failureReason}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>時系列</CardTitle>
        </CardHeader>
        <CardContent>
          <Timeline entries={run.timeline} now={now} />
        </CardContent>
      </Card>
    </div>
  );
};

/**
 * 失敗（存在しない `run_key` を開いたときもここに来る）。
 *
 * **「無い」と「読めなかった」を書き分けない。** サーバーは種別だけを返す
 * 約束で（plans/security.md 脅威 12）、画面で書き分けると
 * `run_key` の存在の有無が総当たりで読み取れる。
 */
const RunDetailError = ({ reset }: ErrorComponentProps) => {
  const router = useRouter();

  return (
    <div className="flex flex-col items-center gap-4">
      <ErrorState
        title="この run を読み込めませんでした"
        onRetry={() => {
          reset();
          void router.invalidate();
        }}
      />
      <Link to="/runs" className="text-sm underline underline-offset-2">
        run の一覧へ戻る
      </Link>
    </div>
  );
};

export const Route = createFileRoute("/_authed/runs/$runKey")({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(
      orpc.runs.detail.queryOptions({ input: { runKey: params.runKey } }),
    ),
  component: RunDetail,
  pendingComponent: () => <LoadingRows rows={6} />,
  errorComponent: RunDetailError,
});
