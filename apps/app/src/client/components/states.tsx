import { AlertCircleIcon, RefreshIcon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@workspace/ui/components/ui/button";
import { Skeleton } from "@workspace/ui/components/ui/skeleton";

/*
  空・読み込み・失敗の 3 状態（計画 P7a §3-5・§8）。**P7b が使い回す。**

  3 つを 1 ファイルに置いてあるのは、**どの画面もこの 3 つを揃って持つ**ため ——
  1 つだけ import している画面があれば、残り 2 つを忘れている合図になる。
*/

export const EmptyState = ({
  icon,
  title,
  hint,
}: {
  readonly icon: IconSvgElement;
  readonly title: string;
  readonly hint?: string | undefined;
}) => (
  <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
    <HugeiconsIcon
      icon={icon}
      strokeWidth={2}
      className="size-6 text-muted-foreground"
    />
    <p className="font-medium text-sm">{title}</p>
    {hint === undefined ? null : (
      <p className="text-muted-foreground text-xs">{hint}</p>
    )}
  </div>
);

/**
 * 読み込み中の骨組み。
 *
 * **`role="status"` を付ける。** 素の `<div>` に `aria-busy` を置いても
 * 支援技術には届かない（生成的な role は live region の属性を受けない）。
 */
export const LoadingRows = ({ rows = 5 }: { readonly rows?: number }) => (
  <div
    className="flex flex-col gap-2 py-2"
    role="status"
    aria-busy="true"
    aria-label="読み込み中"
  >
    {Array.from({ length: rows }, (_, index) => (
      <Skeleton key={index} className="h-8 w-full" />
    ))}
  </div>
);

/**
 * 失敗（計画 P7a §3-5「3 状態を必ず持つ」）。
 *
 * **理由の文字列を出さない。** サーバーは種別だけを返す約束で
 * （plans/security.md 脅威 12）、ここに `error.message` を流すと
 * 例外の中身が画面に出る経路ができる。
 */
export const ErrorState = ({
  title = "読み込めませんでした",
  onRetry,
}: {
  readonly title?: string;
  readonly onRetry: () => void;
}) => (
  <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
    <HugeiconsIcon
      icon={AlertCircleIcon}
      strokeWidth={2}
      className="size-6 text-destructive"
    />
    <p className="font-medium text-sm">{title}</p>
    <Button variant="outline" size="sm" onClick={onRetry}>
      <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />
      再試行
    </Button>
  </div>
);
