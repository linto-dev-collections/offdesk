import { describe, expect, it } from "vitest";
import type { NavItem } from "../../src/client/lib/nav.ts";
import { NAV_ITEMS, navItemFor } from "../../src/client/lib/nav.ts";

/*
  サイドバーの現在地（P7a §9-4 の「入れ子のルートが入る時点で直す」）。

  **完全一致だけだった実装を 2 段にした。** `/runs/$runKey` を開いたときに
  サイドバーの「run」が光らないと、いまどこを見ているか分からなくなる。
*/

const isPlanned = (
  item: NavItem,
): item is Extract<NavItem, { kind: "planned" }> => item.kind === "planned";

describe("navItemFor", () => {
  it("ダッシュボードは完全一致で当たる", () => {
    expect(navItemFor("/")?.label).toBe("ダッシュボード");
  });

  it("run の一覧は完全一致で当たる", () => {
    expect(navItemFor("/runs")?.label).toBe("run");
  });

  /** 入れ子のルート。ここが当たらないと詳細画面でサイドバーの光が消える。 */
  it("run の詳細は前方一致で run に当たる", () => {
    expect(navItemFor("/runs/OFFDESK-1111111111111111")?.label).toBe("run");
  });

  /*
    **`/` の前方一致を効かせない。** 効かせると全ページが
    「ダッシュボード」に当たって、光が動かなくなる。
  */
  it("/ は前方一致では当たらない", () => {
    expect(navItemFor("/login")).toBeUndefined();
  });

  /** 区切りを含めて比べているので、名前の途中一致では当たらない。 */
  it("/runsomething には当たらない", () => {
    expect(navItemFor("/runsomething")).toBeUndefined();
  });

  it("未実装の項目には当たらない（to を持たない）", () => {
    expect(navItemFor("/plans")).toBeUndefined();
    expect(navItemFor("/projects")).toBeUndefined();
    expect(navItemFor("/gateway")).toBeUndefined();
  });

  /**
   * **返るのは `NAV_ITEMS` の要素そのもの。** サイドバーは
   * `current === item` の参照比較で強調しているので、写しを返すと光らない。
   */
  it("項目の実体そのものを返す", () => {
    const runItem = NAV_ITEMS.find((item) => item.label === "run");

    expect(navItemFor("/runs")).toBe(runItem);
  });
});

describe("NAV_ITEMS", () => {
  /** 要件 §5-6 の 5 画面。P7b が残り 3 つを live にする（§8 の引き渡し）。 */
  it("5 項目が並んでいる", () => {
    expect(NAV_ITEMS).toHaveLength(5);
  });

  it("P7a の 2 つが live になっている", () => {
    const live = NAV_ITEMS.filter((item) => item.kind === "live");

    expect(live.map((item) => item.label)).toEqual(["ダッシュボード", "run"]);
  });

  it("残りは planned で、フェーズの札を持つ", () => {
    const planned = NAV_ITEMS.filter(isPlanned);

    expect(planned).toHaveLength(3);
    for (const item of planned) {
      expect(item.phase).toBe("P7b");
    }
  });

  /** 同じ行き先を 2 つ持たない（`navItemFor` が「最初の 1 つ」を返すので）。 */
  it("live の行き先が重複していない", () => {
    const targets = NAV_ITEMS.filter((item) => item.kind === "live").map(
      (item) => (item.kind === "live" ? item.to : ""),
    );

    expect(new Set(targets).size).toBe(targets.length);
  });
});
