import {
  AlertCircleIcon,
  ArchiveIcon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  HelpCircleIcon,
  PlayIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import type { RunStatus } from "@offdesk/contract";
import { Badge } from "@workspace/ui/components/ui/badge";

type StatusStyle = {
  readonly label: string;
  readonly variant: "default" | "secondary" | "destructive" | "outline";
  readonly icon: IconSvgElement;
  readonly className?: string;
};

/**
 * 6 状態すべてに 1 つずつ（完了条件）。
 *
 * **`Record<RunStatus, …>` にするのが分岐漏れの検査。** 状態を足すと
 * ここがコンパイルエラーになる（`assertNever` の `switch` と同じ効き方で、
 * 表引きのときはこちらの方が短い）。
 *
 * **色は 3 系統しか無い**（トークンは neutral ＋ primary の青 ＋ destructive の赤。
 * 要件 §10-4 のプリセットが出す値で、コンポーネントに色を直書きしない）。
 * なので**塗りを 1 つだけ「人を待っている」に割り当てた** ——
 * `waiting` は人が動くまで進まない唯一の状態で、ここに気づけないことが
 * offdesk がいちばん避けたい詰まり方（要件 `F-B`）。
 * 残り 5 つは枠と控えめな塗り ＋ アイコンで分ける。
 */
const STATUS_STYLES: Record<RunStatus, StatusStyle> = {
  queued: { label: "待機", variant: "outline", icon: Clock01Icon },
  running: { label: "実行中", variant: "secondary", icon: PlayIcon },
  waiting: { label: "回答待ち", variant: "default", icon: HelpCircleIcon },
  done: {
    label: "完了",
    variant: "outline",
    icon: CheckmarkCircle02Icon,
    className: "text-muted-foreground",
  },
  failed: { label: "失敗", variant: "destructive", icon: AlertCircleIcon },
  abandoned: {
    label: "破棄",
    variant: "outline",
    icon: ArchiveIcon,
    className: "text-destructive",
  },
};

export const runStatusLabel = (status: RunStatus): string =>
  STATUS_STYLES[status].label;

export const RunStatusBadge = ({ status }: { status: RunStatus }) => {
  const style = STATUS_STYLES[status];

  return (
    <Badge variant={style.variant} className={style.className}>
      {/* `data-icon` は生成物の CSS が余白を詰めるのに見ている（`badge.tsx`）。 */}
      <HugeiconsIcon
        icon={style.icon}
        strokeWidth={2}
        data-icon="inline-start"
      />
      {style.label}
    </Badge>
  );
};
