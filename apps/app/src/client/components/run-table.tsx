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

  /*
    **`table-fixed` にする**（2026-09-06 に長いプロンプトで崩れて直した）。

    2 つが重なっていた ——
    `TableCell` の既定が `whitespace-nowrap` なのでプロンプトが折り返さず、
    `max-w-md` は **auto layout の `<td>` には効かない**（CSS の仕様で表セルには
    `max-width` が適用されない）。結果、プロンプト列の最小幅が 120 字ぶんになり、
    **他の列が潰れて横に溢れた。**

    固定レイアウトなら**列幅は中身で変わらない。** 幅を書いていない
    プロンプト列が残りを取り、狭い画面では `Table` が持つ
    `overflow-x-auto` で横スクロールに落ちる（潰さずに逃がす）。
  */
  return (
    <Table className="min-w-[64rem] table-fixed">
      <TableHeader>
        <TableRow>
          <TableHead className="w-24">状態</TableHead>
          <TableHead className="w-40">プロジェクト</TableHead>
          {/* 幅を書かない = 残りを全部取る */}
          <TableHead>プロンプト</TableHead>
          <TableHead className="w-56">使用量</TableHead>
          <TableHead className="w-36">開始</TableHead>
          <TableHead className="w-32">所要</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => (
          /* 行の高さが揃わないので、上端で揃える。 */
          <TableRow key={item.runKey} className="[&>td]:align-top">
            <TableCell>
              <RunStatusBadge status={item.status} />
            </TableCell>
            <TableCell className="whitespace-nowrap">
              {/* 固定幅なので、溢れる名前は切って全文を `title` に残す。 */}
              <div className="truncate" title={item.projectName}>
                {item.projectName}
              </div>
            </TableCell>
            <TableCell className="whitespace-normal">
              {/*
                **2 行で止める。** 本文はサーバー側で 120 字に切ってあるが、
                それでも 1 行には収まらない —— 行の高さが揃わないと表として
                読めなくなるので、`title` に全文を残して見た目を揃える。
                `break-words` は URL のような切れ目の無い語を折るため。
              */}
              <Link
                to="/runs/$runKey"
                params={{ runKey: item.runKey }}
                title={item.prompt}
                className="line-clamp-2 break-words underline underline-offset-2"
              >
                {item.prompt}
                {item.promptTruncated ? "…" : ""}
              </Link>
              <div className="mt-1 flex items-center gap-3">
                <span className="min-w-0 truncate text-muted-foreground text-xs tabular-nums">
                  {item.runKey}
                </span>
                {/* run_key に押されてリンクが消えないようにする。 */}
                <span className="shrink-0">
                  <ThreadLink url={item.threadUrl} />
                </span>
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
  );
};
