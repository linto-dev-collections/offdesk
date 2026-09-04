import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "../../src/client/components/confirm-dialog.tsx";

/*
  戻せない操作の前の確認（計画 P7b §3-1「確認ダイアログを挟む」）。

  **ここで固めるのは「自分では閉じない」こと。** 押した瞬間に閉じる作りだと、
  通信が失敗したときに「消えたように見えて消えていない」画面になる ——
  閉じるのは呼ぶ側（`_authed/plans.tsx` が `onSuccess` で閉じる）。
*/

const props = {
  open: true,
  onOpenChange: () => undefined,
  title: "この計画を取り消しますか",
  description: "phase-07b（3 ファイル）を消します。戻せません。",
  confirmLabel: "取り消す",
  onConfirm: () => undefined,
};

describe("ConfirmDialog", () => {
  it("open なら題と説明と 2 つのボタンが出る", () => {
    render(<ConfirmDialog {...props} />);

    expect(screen.getByText(props.title)).toBeDefined();
    expect(screen.getByText(props.description)).toBeDefined();
    expect(screen.getByRole("button", { name: "取り消す" })).toBeDefined();
    expect(screen.getByRole("button", { name: "やめる" })).toBeDefined();
  });

  it("open が false なら何も出ない", () => {
    render(<ConfirmDialog {...props} open={false} />);

    expect(screen.queryByText(props.title)).toBeNull();
  });

  it("実行を押すと onConfirm が呼ばれる", () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog {...props} onConfirm={onConfirm} />);

    screen.getByRole("button", { name: "取り消す" }).click();

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  /** **押しても自分では閉じない**（`onOpenChange` を呼ばない）。 */
  it("実行を押しても onOpenChange は呼ばれない", () => {
    const onOpenChange = vi.fn();
    render(<ConfirmDialog {...props} onOpenChange={onOpenChange} />);

    screen.getByRole("button", { name: "取り消す" }).click();

    expect(onOpenChange).not.toHaveBeenCalled();
  });

  /** 通信の間は両方押せない（2 回消しに行かない）。 */
  it("pending なら両方のボタンが無効", () => {
    render(<ConfirmDialog {...props} pending={true} />);

    expect(
      screen.getByRole("button", { name: "取り消す" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: "やめる" }).hasAttribute("disabled"),
    ).toBe(true);
  });
});
