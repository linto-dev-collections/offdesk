import type { PlanSummary } from "@offdesk/contract";
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlanTable } from "../../src/client/components/plan-table.tsx";
import { renderWithRouter } from "./support.tsx";

const NOW = Date.UTC(2026, 8, 5, 3, 0, 0);
const MINUTE = 60_000;

const plan = (overrides: Partial<PlanSummary> = {}): PlanSummary => ({
  planId: "a".repeat(32),
  scopeKind: "thread",
  scopeLabel: "444444444444444444",
  scopeUrl: "https://discord.com/channels/999/444444444444444444",
  slug: "phase-07b",
  fileCount: 3,
  totalBytes: 231_647,
  updatedAt: NOW - 10 * MINUTE,
  viewUrl: `/p/${"a".repeat(32)}/`,
  lastPublishedRunKey: "OFFDESK-1111111111111111",
  ...overrides,
});

describe("PlanTable", () => {
  it("名前・ファイル数・合計・最終更新が出る", async () => {
    await renderWithRouter(
      <PlanTable items={[plan()]} now={NOW} onRemove={() => undefined} />,
    );

    expect(screen.getByText("phase-07b")).toBeDefined();
    expect(screen.getByText("3")).toBeDefined();
    expect(screen.getByText("226.2 KB")).toBeDefined();
    expect(screen.getByText("10 分前")).toBeDefined();
  });

  /** 開くのは Worker が返す素の HTML なので `<a href>`（`<Link>` ではない）。 */
  it("名前が /p/<planId>/ へのリンクになっている", async () => {
    await renderWithRouter(
      <PlanTable items={[plan()]} now={NOW} onRemove={() => undefined} />,
    );

    const link = screen.getByText("phase-07b").closest("a");
    expect(link?.getAttribute("href")).toBe(`/p/${"a".repeat(32)}/`);
    expect(link?.getAttribute("target")).toBe("_blank");
  });

  it("最後に置いた run が詳細へのリンクになっている", async () => {
    await renderWithRouter(
      <PlanTable items={[plan()]} now={NOW} onRemove={() => undefined} />,
    );

    const link = screen.getByText("OFFDESK-1111111111111111").closest("a");
    expect(link?.getAttribute("href")).toBe("/runs/OFFDESK-1111111111111111");
  });

  it("スレッドのリンクが出る", async () => {
    await renderWithRouter(
      <PlanTable items={[plan()]} now={NOW} onRemove={() => undefined} />,
    );

    const link = screen.getByText("スレッド").closest("a");
    expect(link?.getAttribute("href")).toBe(
      "https://discord.com/channels/999/444444444444444444",
    );
  });

  /*
    **`DISCORD_GUILD_ID` が未設定でもスレッドの id は残す**（`scopeLabel`）。
    リンクが組めないだけで、どのスレッドのものかは分かる必要がある。
  */
  it("scopeUrl が null なら id を素で出す", async () => {
    await renderWithRouter(
      <PlanTable
        items={[plan({ scopeUrl: null })]}
        now={NOW}
        onRemove={() => undefined}
      />,
    );

    expect(screen.getByText("444444444444444444")).toBeDefined();
    expect(screen.queryByText("スレッド")).toBeNull();
  });

  /** スレッドを立てられなかった run の計画（要件 `F-A7`）。 */
  it("run スコープなら「スレッド無し」と出る", async () => {
    await renderWithRouter(
      <PlanTable
        items={[
          plan({
            scopeKind: "run",
            scopeLabel: "OFFDESK-1111111111111111",
            scopeUrl: null,
          }),
        ]}
        now={NOW}
        onRemove={() => undefined}
      />,
    );

    expect(screen.getByText("スレッド無し")).toBeDefined();
  });

  it("取り消すを押すとその行の計画が渡る", async () => {
    const onRemove = vi.fn();
    await renderWithRouter(
      <PlanTable items={[plan()]} now={NOW} onRemove={onRemove} />,
    );

    screen.getByRole("button", { name: "phase-07b を取り消す" }).click();

    expect(onRemove).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "phase-07b" }),
    );
  });

  /*
    **押した時点では消さない**（確認ダイアログを挟む。計画 P7b §3-1）。
    ここでは「渡すだけ」であることを、表の側から固める。
  */
  it("1 行に取り消しのボタンが 1 つだけある", async () => {
    await renderWithRouter(
      <PlanTable items={[plan()]} now={NOW} onRemove={() => undefined} />,
    );

    expect(screen.getAllByRole("button", { name: /を取り消す/ })).toHaveLength(
      1,
    );
  });

  it("0 件なら置き方の案内が出る", async () => {
    await renderWithRouter(
      <PlanTable items={[]} now={NOW} onRemove={() => undefined} />,
    );

    expect(screen.getByText("置かれた計画はありません")).toBeDefined();
    expect(screen.getByText(/publish-plan\.sh/)).toBeDefined();
  });
});
