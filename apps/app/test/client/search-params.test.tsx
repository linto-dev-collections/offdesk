import { RUN_SINCE_DAYS_DEFAULT, type RunListQuery } from "@offdesk/contract";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RunFilters } from "../../src/client/components/run-filters.tsx";
import { RunTable } from "../../src/client/components/run-table.tsx";
import { renderWithSearch } from "./support.tsx";

/*
  型付き search params（要件 `F-F2`・完了条件）。

  検査しているのは 3 つ:
    1. URL を直に開いても絞り込みが復元される
    2. **不正な値でも画面が壊れない**（Zod の `.catch()` で既定値へ）
    3. 既定値のままなら URL に何も足さない

  **本物のルートファイルは読まない**（`support.tsx` の理由）。同じ
  `validateSearch: RunListQuery` を持つ router を組んで、そこを通した値を描く。
*/

const NOW = Date.UTC(2026, 8, 5, 3, 0, 0);

const seen: { current: RunListQuery | null } = { current: null };

const screenFor = async (entry: string): Promise<RunListQuery> => {
  seen.current = null;

  await renderWithSearch({
    initialEntry: entry,
    render: (search) => {
      seen.current = search;

      return (
        <>
          <RunFilters
            query={search}
            projects={[{ id: "p1", name: "offdesk-test" }]}
            onChange={() => {}}
            onReset={() => {}}
          />
          <RunTable items={[]} now={NOW} />
        </>
      );
    },
  });

  const value = seen.current;
  if (value === null) throw new Error("search が読めませんでした");
  return value;
};

describe("URL を直に開いたときの復元", () => {
  it("何も付いていなければ既定値になる", async () => {
    const search = await screenFor("/runs");

    expect(search).toEqual({
      sinceDays: RUN_SINCE_DAYS_DEFAULT,
      page: 1,
      sort: "createdAt",
      order: "desc",
    });
  });

  it("絞り込みとページングが復元される", async () => {
    const search = await screenFor(
      "/runs?projectId=p1&status=running&sinceDays=7&page=2&sort=updatedAt&order=asc",
    );

    expect(search).toEqual({
      projectId: "p1",
      status: "running",
      sinceDays: 7,
      page: 2,
      sort: "updatedAt",
      order: "asc",
    });
  });

  /** 数字は文字列で届くこともある（`parseSearch` の既定は JSON.parse を試す）。 */
  it("数字が文字列で来ても数値になる", async () => {
    const search = await screenFor("/runs?page=%223%22");

    expect(search.page).toBe(3);
  });

  it("復元した絞り込みが画面に出る", async () => {
    await screenFor("/runs?projectId=p1&status=waiting");

    expect(screen.getByText("offdesk-test")).toBeDefined();
    expect(screen.getByText("回答待ち")).toBeDefined();
    // 既定と違う値が入っているので「外す」ボタンが出る。
    expect(screen.getByText("絞り込みを外す")).toBeDefined();
  });

  it("既定値のままなら「絞り込みを外す」は出ない", async () => {
    await screenFor("/runs");

    expect(screen.queryByText("絞り込みを外す")).toBeNull();
  });
});

describe("不正な search params でも画面が壊れない", () => {
  it("page=abc は 1 に倒れる", async () => {
    const search = await screenFor("/runs?page=abc");

    expect(search.page).toBe(1);
  });

  it("status=nope は「すべて」に倒れる", async () => {
    const search = await screenFor("/runs?status=nope");

    expect(search.status).toBeUndefined();
  });

  /*
    **`sort` の allowlist の外は既定値へ**（plans/security.md 脅威 11）。
    ここで倒れることが、受け取った文字列が `ORDER BY` に届かないという
    保証の 1 層目（2 層目は `packages/db` の列の表引き）。
  */
  it("sort=prompt は createdAt に倒れる", async () => {
    const search = await screenFor("/runs?sort=prompt");

    expect(search.sort).toBe("createdAt");
  });

  it("order=sideways は desc に倒れる", async () => {
    const search = await screenFor("/runs?order=sideways");

    expect(search.order).toBe("desc");
  });

  it("sinceDays=0 と 9999 は既定値に倒れる", async () => {
    expect((await screenFor("/runs?sinceDays=0")).sinceDays).toBe(
      RUN_SINCE_DAYS_DEFAULT,
    );
    expect((await screenFor("/runs?sinceDays=9999")).sinceDays).toBe(
      RUN_SINCE_DAYS_DEFAULT,
    );
  });

  it("page=-1 は 1 に倒れる", async () => {
    expect((await screenFor("/runs?page=-1")).page).toBe(1);
  });

  /** 空文字は「すべて」（`.min(1)` が落として `.catch(undefined)` が受ける）。 */
  it("projectId= は「すべて」に倒れる", async () => {
    expect((await screenFor("/runs?projectId=")).projectId).toBeUndefined();
  });

  /*
    **知らないキーは残る**（2026-09-05 に実測）。TanStack Router の search は
    ルートの階層で共有されるもので、`validateSearch` を持たない root が
    素の値をそのまま通す —— **子の検証結果はその上に重ねられる。**

    だから「知らないキーが消える」ことには頼れない。頼っているのは
      1. 型に無いので**画面のコードからは読めない**
      2. oRPC の入力検証（同じ `RunListQuery`）が**サーバー側で落とす**
    の 2 つ（2 は `test/rpc/runs-list.test.ts` が見ている）。
  */
  it("知らないキーは残るが、既知のキーの正規化は効く", async () => {
    const search = await screenFor("/runs?nope=1&page=abc");

    expect(search).toHaveProperty("nope", 1);
    expect(search.page).toBe(1);
  });

  /**
   * **全部まとめて壊しても描画まで届く**（完了条件「画面が壊れない」）。
   * `.catch()` を 1 つでも落とすと、ここが例外で落ちる。
   */
  it("全部まとめて不正でも画面が描かれる", async () => {
    const search = await screenFor(
      "/runs?projectId=&status=nope&sinceDays=abc&page=abc&sort=x&order=y",
    );

    // `projectId=` の空文字は素の値として残る（上の「知らないキー」と同じ仕組み）ので、
    // 検証を通った既知のキーだけを取り出して比べる。
    expect({
      sinceDays: search.sinceDays,
      page: search.page,
      sort: search.sort,
      order: search.order,
    }).toEqual({
      sinceDays: RUN_SINCE_DAYS_DEFAULT,
      page: 1,
      sort: "createdAt",
      order: "desc",
    });
    expect(search.status).toBeUndefined();
    expect(screen.getByText("この条件に合う run はありません")).toBeDefined();
  });
});
