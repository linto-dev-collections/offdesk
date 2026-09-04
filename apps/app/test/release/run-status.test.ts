import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
  run の状態の一覧が **4 か所**にある。

    packages/db/src/schema/offdesk.ts        runs_status_ck（DDL。これが正本）
    packages/db/src/repositories/run.ts      RUN_STATUSES
    packages/contract/src/run.ts             RUN_STATUSES（Zod の enum）
    packages/usecase/src/list-runs.ts        RunStatusView（合併型）

  **1 本にできない。** `packages/contract` は依存の終着点なので下流から型を
  貰えず（要件 `I-8`・`contract-is-terminal`）、`packages/db` と
  `packages/usecase` は API の契約に依存できない（矢印が逆を向く）。
  `FIRE_URL_PREFIX` が domain と contract の 2 か所にあるのと同じ事情。

  **食い違ったときの壊れ方が読みにくい。** DDL にだけ足すと「その状態の run が
  一覧で 500」、契約にだけ足すと「D1 の CHECK 違反」——どちらも状態の名前が
  出てこない。ここが緑である限りその食い違いは起きない。

  正規表現でソースを読むのは `env-required.test.ts` と同じ理由
  （`alchemy.run.ts` が import できないのと違い、ここは import してもよいが、
  **4 か所を同じやり方で読む**方が漏れに気付きやすい）。
*/

const REPO_ROOT = path.join(import.meta.dirname, "../../../..");

const readSource = (relative: string): string =>
  readFileSync(path.join(REPO_ROOT, relative), "utf8");

/** `const NAME ... = [ ... ]` の中の文字列リテラル（`env-required.test.ts` と同じ形）。 */
const arrayLiterals = (source: string, constant: string): readonly string[] => {
  const block = new RegExp(
    `const ${constant}[^=]*=\\s*\\[([\\s\\S]*?)\\]`,
  ).exec(source);
  if (block?.[1] === undefined) {
    throw new Error(`${constant} の宣言が見つかりません`);
  }
  return [...block[1].matchAll(/"([a-z_]+)"/g)].map((match) => match[1] ?? "");
};

/** `export type NAME = | "a" | "b";` の中の文字列リテラル。 */
const unionLiterals = (source: string, name: string): readonly string[] => {
  const block = new RegExp(`export type ${name} =([\\s\\S]*?);`).exec(source);
  if (block?.[1] === undefined) {
    throw new Error(`${name} の宣言が見つかりません`);
  }
  return [...block[1].matchAll(/"([a-z_]+)"/g)].map((match) => match[1] ?? "");
};

/** DDL の `IN ('a', 'b')`。**CHECK の名前を錨にする**（散文に出てきても壊れない）。 */
const checkLiterals = (
  source: string,
  checkName: string,
): readonly string[] => {
  const block = new RegExp(`"${checkName}"[\\s\\S]*?IN \\(([^)]*)\\)`).exec(
    source,
  );
  if (block?.[1] === undefined) {
    throw new Error(`${checkName} の宣言が見つかりません`);
  }
  return [...block[1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1] ?? "");
};

const SCHEMA = readSource("packages/db/src/schema/offdesk.ts");
const DB_REPO = readSource("packages/db/src/repositories/run.ts");
const CONTRACT = readSource("packages/contract/src/run.ts");
const USECASE = readSource("packages/usecase/src/list-runs.ts");
const DASHBOARD = readSource("packages/usecase/src/get-dashboard.ts");

const ddlStatuses = checkLiterals(SCHEMA, "runs_status_ck");

describe("run の状態の一覧", () => {
  it("DDL が 6 状態を持つ（要件 §5-1 の状態機械）", () => {
    expect(ddlStatuses).toEqual([
      "queued",
      "running",
      "waiting",
      "done",
      "failed",
      "abandoned",
    ]);
  });

  it("packages/db の写しが DDL と一致する", () => {
    expect(arrayLiterals(DB_REPO, "RUN_STATUSES")).toEqual(ddlStatuses);
  });

  it("packages/contract の写しが DDL と一致する", () => {
    expect(arrayLiterals(CONTRACT, "RUN_STATUSES")).toEqual(ddlStatuses);
  });

  it("packages/usecase の写しが DDL と一致する", () => {
    expect(unionLiterals(USECASE, "RunStatusView")).toEqual(ddlStatuses);
  });
});

describe("ダッシュボードの状態のまとまり", () => {
  const live = arrayLiterals(DASHBOARD, "DASHBOARD_LIVE_STATUSES");
  const failed = arrayLiterals(DASHBOARD, "DASHBOARD_FAILED_STATUSES");

  it("走っている 3 状態は終端でないもの", () => {
    expect(live).toEqual(["queued", "running", "waiting"]);
  });

  it("失敗は failed と abandoned（done を混ぜない）", () => {
    expect(failed).toEqual(["failed", "abandoned"]);
  });

  it("2 つのまとまりは重ならない", () => {
    for (const status of live) {
      expect(failed).not.toContain(status);
    }
  });

  /*
    **6 状態が漏れなく分かれている。** `done` だけがどちらにも入らない
    （成功は気づく必要が無い）。状態を足したときに、
    **どちらのカードにも出ない状態が黙って生まれる**のをここで止める。
  */
  it("live ＋ failed ＋ done で 6 状態すべてになる", () => {
    expect(new Set([...live, ...failed, "done"])).toEqual(new Set(ddlStatuses));
  });
});

describe("並び替えに使える列", () => {
  /*
    plans/security.md 脅威 11。**契約の `z.enum` と `packages/db` の表引きが
    同じ 2 値**であること —— 契約にだけ足すと、`RUN_SORT_COLUMNS` の
    表引きが `undefined` を返して `ORDER BY` が消える（並びが黙って壊れる）。
  */
  it("契約の enum と packages/db の列の表が一致する", () => {
    const contractSort = /RunSort = z\.enum\(\[([^\]]*)\]\)/.exec(CONTRACT);
    const columns = /const RUN_SORT_COLUMNS = \{([\s\S]*?)\} as const/.exec(
      DB_REPO,
    );

    expect(contractSort?.[1]).toBeDefined();
    expect(columns?.[1]).toBeDefined();

    const fromContract = [
      ...(contractSort?.[1] ?? "").matchAll(/"([A-Za-z]+)"/g),
    ].map((match) => match[1]);
    const fromDb = [...(columns?.[1] ?? "").matchAll(/^\s*([A-Za-z]+):/gm)].map(
      (match) => match[1],
    );

    expect(fromDb).toEqual(fromContract);
  });

  /** **列名を文字列で受ける口を作らない。** `ORDER BY` を組む場所は 1 か所だけ。 */
  it("packages/db に文字列を直に埋める orderBy が無い", () => {
    expect(DB_REPO).not.toMatch(/orderBy\(sql/);
    expect(DB_REPO).not.toMatch(/ORDER BY \$\{/);
  });
});
