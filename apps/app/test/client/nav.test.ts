import { describe, expect, it } from "vitest";
import { NAV_ITEMS, navItemFor } from "../../src/client/lib/nav.ts";

/*
  サイドバーの現在地（P7a §9-4 の「入れ子のルートが入る時点で直す」）。

  **完全一致だけだった実装を 2 段にした。** `/runs/$runKey` を開いたときに
  サイドバーの「run」が光らないと、いまどこを見ているか分からなくなる。

  **P7b で `kind: "planned"` が消えた。** 5 画面すべてが実装済みになったので、
  「押せない項目」の分岐を持たない（`lib/nav.ts` の why）。
*/

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

  it.each([
    ["/plans", "計画"],
    ["/projects", "プロジェクト"],
    ["/operations", "運用"],
  ])("%s は %s に当たる（P7b の 3 画面）", (pathname, label) => {
    expect(navItemFor(pathname)?.label).toBe(label);
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

  it("知らないパスには当たらない", () => {
    expect(navItemFor("/gateway")).toBeUndefined();
    expect(navItemFor("/settings")).toBeUndefined();
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
  /** 要件 §5-6 の 5 画面（run 一覧と run 詳細を 1 項目に数える）。 */
  it("5 項目が並んでいる", () => {
    expect(NAV_ITEMS).toHaveLength(5);
  });

  it("要件 §5-6 の順で並んでいる", () => {
    expect(NAV_ITEMS.map((item) => item.label)).toEqual([
      "ダッシュボード",
      "run",
      "計画",
      "プロジェクト",
      "運用",
    ]);
  });

  /*
    **全部に行き先がある**（P7b の完了条件「画面が 5 つ揃っている」）。
    押せない項目が残っていたら、そのフェーズが終わっていない合図。
  */
  it("すべての項目に行き先がある", () => {
    for (const item of NAV_ITEMS) {
      expect(item.to.startsWith("/")).toBe(true);
    }
  });

  /** 同じ行き先を 2 つ持たない（`navItemFor` が「最初の 1 つ」を返すので）。 */
  it("行き先が重複していない", () => {
    const targets = NAV_ITEMS.map((item) => item.to);

    expect(new Set(targets).size).toBe(targets.length);
  });
});
