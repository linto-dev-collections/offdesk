import {
  BlueprintIcon,
  Delete02Icon,
  LinkSquare02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  formatBytes,
  formatJst,
  formatRelativeJst,
  type PlanSummary,
} from "@offdesk/contract";
import { Link } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/ui/table";
import { ThreadLink } from "./run-table.tsx";
import { EmptyState } from "./states.tsx";

/**
 * その計画が属する場所（要件 `F-E4`）。
 *
 * **スレッドが無い計画がある。** `F-A7` の「スレッドを立てられなかった」run が
 * 置いたものがそれで、`scope_kind` が `run` になる —— そのときリンクは無いので、
 * **「スレッド無し」と明記する**（空欄だと、リンクの生成に失敗したのか
 * そもそも無いのかが読めない）。
 */
const PlanScope = ({ plan }: { readonly plan: PlanSummary }) => {
  if (plan.scopeKind === "run") {
    return <span className="text-muted-foreground text-xs">スレッド無し</span>;
  }

  return plan.scopeUrl === null ? (
    <span
      className="text-muted-foreground text-xs tabular-nums"
      title="DISCORD_GUILD_ID が未設定なので、リンクは組めません"
    >
      {plan.scopeLabel}
    </span>
  ) : (
    <ThreadLink url={plan.scopeUrl} />
  );
};

/**
 * 計画一覧（要件 `F-F` の「計画一覧」・計画 P7b §3-1）。
 *
 * **`fileCount` / `totalBytes` は台帳の控えをそのまま出す。** 正本は R2 だが、
 * **画面に「控えである」ことは書かない**（計画 P7b §3-1）——
 * R2 と数が合わないのは `finish` が途中で失敗した合図なので、
 * 見えている方が役に立つ。
 */
export const PlanTable = ({
  items,
  now,
  onRemove,
}: {
  readonly items: readonly PlanSummary[];
  readonly now: number;
  readonly onRemove: (plan: PlanSummary) => void;
}) => {
  if (items.length === 0) {
    return (
      <EmptyState
        icon={BlueprintIcon}
        title="置かれた計画はありません"
        hint="cloud session の中から publish-plan.sh で置くと、ここに並びます"
      />
    );
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>名前</TableHead>
            <TableHead>置き場</TableHead>
            <TableHead>ファイル</TableHead>
            <TableHead>合計</TableHead>
            <TableHead>最終更新</TableHead>
            <TableHead className="text-end">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((plan) => (
            <TableRow key={plan.planId}>
              <TableCell>
                {/*
                  **`<a>` で開く**（`<Link>` ではない）。`/p/<id>/` は Worker が
                  返す素の HTML で、SPA のルートではない —— `<Link>` にすると
                  router が知らない行き先になって型が通らない。

                  **開く口はこの 1 つだけ。** 「操作」の欄にも同じ行き先の
                  ボタンを置いていたが、**1 行に同じ宛先が 2 つある**形になった
                  ので名前の側に寄せた（外部リンクの印を付けてある）。
                */}
                <a
                  href={plan.viewUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 underline underline-offset-2"
                >
                  <HugeiconsIcon
                    icon={LinkSquare02Icon}
                    strokeWidth={2}
                    className="size-3.5"
                  />
                  {plan.slug}
                </a>
                <div className="mt-1">
                  <Link
                    to="/runs/$runKey"
                    params={{ runKey: plan.lastPublishedRunKey }}
                    className="text-muted-foreground text-xs tabular-nums underline underline-offset-2"
                  >
                    {plan.lastPublishedRunKey}
                  </Link>
                </div>
              </TableCell>
              <TableCell>
                <PlanScope plan={plan} />
              </TableCell>
              <TableCell className="tabular-nums">{plan.fileCount}</TableCell>
              <TableCell className="whitespace-nowrap tabular-nums">
                {formatBytes(plan.totalBytes)}
              </TableCell>
              <TableCell className="whitespace-nowrap">
                <div className="text-xs">
                  {formatRelativeJst(plan.updatedAt, now)}
                </div>
                <div className="text-muted-foreground text-xs tabular-nums">
                  {formatJst(plan.updatedAt)}
                </div>
              </TableCell>
              <TableCell>
                <div className="flex items-center justify-end">
                  <Button
                    variant="destructive"
                    size="sm"
                    aria-label={`${plan.slug} を取り消す`}
                    onClick={() => onRemove(plan)}
                  >
                    <HugeiconsIcon
                      icon={Delete02Icon}
                      strokeWidth={2}
                      data-icon="inline-start"
                    />
                    取り消す
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
};
