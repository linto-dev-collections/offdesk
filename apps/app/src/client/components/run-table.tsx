import { LinkSquare02Icon, PlayIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  formatDuration,
  formatJst,
  formatRelativeJst,
  type RunSummary,
} from "@offdesk/contract";
import { Link } from "@tanstack/react-router";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/ui/table";
import { ContextBar } from "./context-bar.tsx";
import { RunStatusBadge } from "./run-status-badge.tsx";
import { EmptyState } from "./states.tsx";

/**
 * Discord のスレッドを開くリンク。
 *
 * **`threadUrl` が `null` なら何も出さない**（完了条件）。
 * `DISCORD_GUILD_ID` が未設定か、スレッドをまだ立てられていないかの
 * どちらかで、押せないリンクを出すより黙る方が安い。
 */
export const ThreadLink = ({
  url,
  children,
}: {
  readonly url: string | null;
  readonly children?: string;
}) =>
  url === null ? null : (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-xs underline underline-offset-2"
    >
      <HugeiconsIcon
        icon={LinkSquare02Icon}
        strokeWidth={2}
        className="size-3.5"
      />
      {children ?? "スレッド"}
    </a>
  );

/**
 * run 一覧の表（計画 P7a §3-5）。
 *
 * **`@tanstack/react-table` を入れない。** 並び替え・絞り込み・ページングは
 * すべてサーバー側（URL の search params）にあるので、
 * クライアント側の表の状態機械が要らない ——
 * 入れると「URL と表の 2 か所に状態がある」形になる。
 */
export const RunTable = ({
  items,
  now,
}: {
  readonly items: readonly RunSummary[];
  readonly now: number;
}) => {
  if (items.length === 0) {
    return (
      <EmptyState
        icon={PlayIcon}
        title="この条件に合う run はありません"
        hint="絞り込みを外すか、期間を広げてみてください"
      />
    );
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>状態</TableHead>
            <TableHead>プロジェクト</TableHead>
            <TableHead>プロンプト</TableHead>
            <TableHead>使用量</TableHead>
            <TableHead>開始</TableHead>
            <TableHead>所要</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => (
            <TableRow key={item.runKey}>
              <TableCell>
                <RunStatusBadge status={item.status} />
              </TableCell>
              <TableCell className="whitespace-nowrap">
                {item.projectName}
              </TableCell>
              <TableCell className="max-w-md">
                <Link
                  to="/runs/$runKey"
                  params={{ runKey: item.runKey }}
                  className="underline underline-offset-2"
                >
                  {item.prompt}
                  {item.promptTruncated ? "…" : ""}
                </Link>
                <div className="mt-1 flex items-center gap-3">
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {item.runKey}
                  </span>
                  <ThreadLink url={item.threadUrl} />
                </div>
              </TableCell>
              <TableCell>
                <ContextBar
                  percent={item.contextPercent}
                  usedTokens={item.contextUsedTokens}
                  windowTokens={item.contextWindowTokens}
                  windowKnown={item.contextWindowKnown}
                />
              </TableCell>
              <TableCell className="whitespace-nowrap">
                <div className="text-xs">
                  {formatRelativeJst(item.createdAt, now)}
                </div>
                <div className="text-muted-foreground text-xs tabular-nums">
                  {formatJst(item.createdAt)}
                </div>
              </TableCell>
              <TableCell className="whitespace-nowrap text-xs tabular-nums">
                {/*
                  **終わっていない run は経過時間を出す。** 「まだ動いている」の
                  長さがいちばん見たい数字なので、空欄にしない。
                */}
                {item.finishedAt === null
                  ? `${formatDuration(Math.max(now - item.createdAt, 0))}（継続中）`
                  : formatDuration(item.finishedAt - item.createdAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
};
