import type { RunSummary } from "@offdesk/contract";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RunTable } from "../../src/client/components/run-table.tsx";
import { renderWithRouter } from "./support.tsx";

const NOW = Date.UTC(2026, 8, 5, 3, 0, 0);
const MINUTE = 60_000;

const run = (overrides: Partial<RunSummary> = {}): RunSummary => ({
  runKey: "OFFDESK-1111111111111111",
  projectId: "p1",
  projectName: "offdesk-test",
  status: "running",
  prompt: "テストを足してください",
  promptTruncated: false,
  threadUrl: "https://discord.com/channels/999/444",
  createdAt: NOW - 30 * MINUTE,
  finishedAt: null,
  contextPercent: 42,
  ...overrides,
});

describe("RunTable", () => {
  it("1 行に状態・プロジェクト・プロンプト・run_key が出る", async () => {
    await renderWithRouter(<RunTable items={[run()]} now={NOW} />);

    expect(screen.getByText("実行中")).toBeDefined();
    expect(screen.getByText("offdesk-test")).toBeDefined();
    expect(screen.getByText("テストを足してください")).toBeDefined();
    expect(screen.getByText("OFFDESK-1111111111111111")).toBeDefined();
  });

  it("プロンプトが詳細へのリンクになっている", async () => {
    await renderWithRouter(<RunTable items={[run()]} now={NOW} />);

    const link = screen.getByText("テストを足してください").closest("a");
    expect(link?.getAttribute("href")).toBe("/runs/OFFDESK-1111111111111111");
  });

  /** 切ったことが分かるように `…` を足す（`promptTruncated`）。 */
  it("切られたプロンプトには … が付く", async () => {
    await renderWithRouter(
      <RunTable
        items={[run({ prompt: "長い依頼", promptTruncated: true })]}
        now={NOW}
      />,
    );

    expect(screen.getByText(/長い依頼…/)).toBeDefined();
  });

  /*
    **`threadUrl` が `null` ならリンクを出さない**（完了条件）。
    `DISCORD_GUILD_ID` が未設定のときもここが `null` になる。
  */
  it("スレッドの URL が無ければリンクを出さない", async () => {
    await renderWithRouter(
      <RunTable items={[run({ threadUrl: null })]} now={NOW} />,
    );

    expect(screen.queryByText("スレッド")).toBeNull();
  });

  it("スレッドの URL があれば別タブで開くリンクになる", async () => {
    await renderWithRouter(<RunTable items={[run()]} now={NOW} />);

    const link = screen.getByText("スレッド").closest("a");
    expect(link?.getAttribute("href")).toBe(
      "https://discord.com/channels/999/444",
    );
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noreferrer");
  });

  /*
    **終わっていない run は経過時間 ＋「継続中」。** 空欄にすると
    「どれだけ止まっているか」がいちばん見たいときに読めない。
  */
  it("終わっていない run には継続中の経過時間が出る", async () => {
    await renderWithRouter(<RunTable items={[run()]} now={NOW} />);

    expect(screen.getByText("30 分（継続中）")).toBeDefined();
  });

  it("終わった run には所要時間が出る", async () => {
    await renderWithRouter(
      <RunTable
        items={[
          run({
            status: "done",
            createdAt: NOW - 90 * MINUTE,
            finishedAt: NOW - 25 * MINUTE,
          }),
        ]}
        now={NOW}
      />,
    );

    expect(screen.getByText("1 時間 5 分")).toBeDefined();
  });

  /**
   * バーの塗り幅。**バーは装飾**（`aria-hidden`）なので、
   * 読み上げに使う role ではなく `data-slot` を掴む。
   */
  const barWidth = (): string | undefined =>
    document.querySelector<HTMLElement>('[data-slot="context-bar-fill"]')?.style
      .width;

  it("残量が来ていなければ — になり、バーも出ない", async () => {
    await renderWithRouter(
      <RunTable items={[run({ contextPercent: null })]} now={NOW} />,
    );

    expect(screen.getByText("—")).toBeDefined();
    expect(barWidth()).toBeUndefined();
  });

  it("残量が来ていればバーと % が出る", async () => {
    await renderWithRouter(<RunTable items={[run()]} now={NOW} />);

    expect(screen.getByText("42%")).toBeDefined();
    expect(barWidth()).toBe("42%");
  });

  /** 分母が合っていない run（要件 `F-D4`「203% は隠さない」）。 */
  it("100% を超えても % はそのまま出し、バーだけ満杯で止まる", async () => {
    await renderWithRouter(
      <RunTable items={[run({ contextPercent: 203 })]} now={NOW} />,
    );

    expect(screen.getByText("203%")).toBeDefined();
    expect(barWidth()).toBe("100%");
  });

  it("空なら空の表示になる（3 状態のうちの空）", async () => {
    await renderWithRouter(<RunTable items={[]} now={NOW} />);

    expect(screen.getByText("この条件に合う run はありません")).toBeDefined();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("複数行でも run_key ごとに 1 行になる", async () => {
    await renderWithRouter(
      <RunTable
        items={[
          run(),
          run({ runKey: "OFFDESK-2222222222222222", projectName: "dummy" }),
        ]}
        now={NOW}
      />,
    );

    // 見出しの 1 行を含むので +1。
    expect(screen.getAllByRole("row")).toHaveLength(3);
  });
});
