import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RunPager } from "../../src/client/components/run-pager.tsx";
import { renderWithSearch } from "./support.tsx";

/*
  ページングが URL に載る（要件 `F-F2`・完了条件「50 件でページングされる」）。

  **`href` を見るのが要点。** `onClick` で `navigate` しているだけだと
  中クリックで別タブに開けず、戻るボタンも効かない ——
  「URL に載っている」ことの意味がそこにある。
*/

const pagerAt = async (input: {
  readonly entry: string;
  readonly page: number;
  readonly total: number;
}): Promise<void> => {
  await renderWithSearch({
    initialEntry: input.entry,
    render: () => (
      <RunPager page={input.page} total={input.total} pageSize={50} />
    ),
  });
};

const hrefOf = (label: string): string | null | undefined =>
  screen.getByLabelText(label).closest("a")?.getAttribute("href");

describe("RunPager", () => {
  it("件数と現在のページを出す", async () => {
    await pagerAt({ entry: "/runs?page=2", page: 2, total: 120 });

    expect(
      screen.getByText("120 件中 51–100 件（2 / 3 ページ）"),
    ).toBeDefined();
  });

  it("最後のページでは端数まで数える", async () => {
    await pagerAt({ entry: "/runs?page=3", page: 3, total: 120 });

    expect(
      screen.getByText("120 件中 101–120 件（3 / 3 ページ）"),
    ).toBeDefined();
  });

  /** **絞り込みを保ったまま `page` だけ差し替わる**（`search` に関数を渡している）。 */
  it("次のページのリンクが絞り込みを保つ", async () => {
    await pagerAt({
      entry: "/runs?projectId=p1&status=running&page=2",
      page: 2,
      total: 200,
    });

    const href = hrefOf("次のページ") ?? "";
    expect(href).toContain("page=3");
    expect(href).toContain("projectId=p1");
    expect(href).toContain("status=running");
  });

  it("前のページのリンクも絞り込みを保つ", async () => {
    await pagerAt({
      entry: "/runs?projectId=p1&page=3",
      page: 3,
      total: 200,
    });

    const href = hrefOf("前のページ") ?? "";
    expect(href).toContain("page=2");
    expect(href).toContain("projectId=p1");
  });

  it("1 ページ目では「前」が押せない", async () => {
    await pagerAt({ entry: "/runs", page: 1, total: 120 });

    expect(
      screen.getByLabelText("前のページ").getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("最後のページでは「次」が押せない", async () => {
    await pagerAt({ entry: "/runs?page=3", page: 3, total: 120 });

    expect(
      screen.getByLabelText("次のページ").getAttribute("aria-disabled"),
    ).toBe("true");
  });

  /** 1 ページに収まるなら両方押せない（ページャ自体は出す。総数が読めるので）。 */
  it("1 ページに収まるときは両方押せない", async () => {
    await pagerAt({ entry: "/runs", page: 1, total: 3 });

    expect(screen.getByText("3 件中 1–3 件（1 / 1 ページ）")).toBeDefined();
    expect(
      screen.getByLabelText("次のページ").getAttribute("aria-disabled"),
    ).toBe("true");
  });

  /** 0 件のときは表側が「該当なし」を出すので、ページャは黙る。 */
  it("0 件なら何も出さない", async () => {
    await pagerAt({ entry: "/runs", page: 1, total: 0 });

    expect(screen.queryByLabelText("次のページ")).toBeNull();
  });
});
