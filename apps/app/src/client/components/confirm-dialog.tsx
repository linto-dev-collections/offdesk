import { AlertCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@workspace/ui/components/ui/alert-dialog";

/**
 * 戻せない操作の前に挟む確認（計画 P7b §3-1）。
 *
 * **`alert-dialog` を使う**（`dialog` ではない）。あちらは焦点を閉じ込めた上で
 * **背景を押しても閉じない**ので、「消す」を選んだつもりで背景を押して
 * 消えていた、という取り違えが起きない。
 *
 * **状態を持たない。** `open` は呼ぶ側が持つ —— ここに `useState` を置くと、
 * 「消し終わったら閉じる」を呼ぶ側から命令できなくなる。
 */
export const ConfirmDialog = ({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  pending = false,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly onConfirm: () => void;
  readonly pending?: boolean;
}) => (
  <AlertDialog open={open} onOpenChange={onOpenChange}>
    <AlertDialogContent size="sm">
      <AlertDialogHeader>
        <AlertDialogMedia>
          <HugeiconsIcon
            icon={AlertCircleIcon}
            strokeWidth={2}
            className="text-destructive"
          />
        </AlertDialogMedia>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel disabled={pending}>やめる</AlertDialogCancel>
        {/*
          **`AlertDialogAction` は自分では閉じない**（生成物では素の `Button`）。
          閉じるのは呼ぶ側の仕事 —— 通信が失敗したときに開いたままにできる。
        */}
        <AlertDialogAction
          variant="destructive"
          disabled={pending}
          onClick={onConfirm}
        >
          {confirmLabel}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
);
