import { ArrowLeft01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/ui/button";

/**
 * ページャ（完了条件「一覧が 50 件でページングされる」）。
 *
 * **`<Link>` で組む。** `onClick` ＋ `navigate` でも動くが、
 * リンクなら中クリックで別タブに開けるし、**戻るボタンが効く** ——
 * ページ番号が URL に載っている（要件 `F-F2`）ことの意味がそこにある。
 *
 * `search` に関数を渡すと**今の search を保ったまま `page` だけ差し替わる**。
 * 展開し忘れると絞り込みが消える。
 */
export const RunPager = ({
  page,
  total,
  pageSize,
}: {
  readonly page: number;
  readonly total: number;
  readonly pageSize: number;
}) => {
  const lastPage = Math.max(Math.ceil(total / pageSize), 1);
  if (total === 0) return null;

  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <div className="flex items-center justify-between gap-4">
      <p className="text-muted-foreground text-xs tabular-nums">
        {total} 件中 {first}–{last} 件（{page} / {lastPage} ページ）
      </p>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1}
          render={
            <Link
              to="/runs"
              search={(prev) => ({ ...prev, page: page - 1 })}
              disabled={page <= 1}
              aria-label="前のページ"
            />
          }
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />前
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= lastPage}
          render={
            <Link
              to="/runs"
              search={(prev) => ({ ...prev, page: page + 1 })}
              disabled={page >= lastPage}
              aria-label="次のページ"
            />
          }
        >
          次
          <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} />
        </Button>
      </div>
    </div>
  );
};
