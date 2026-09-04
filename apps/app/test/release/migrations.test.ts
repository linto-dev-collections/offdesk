import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
  移行ファイルの関門（テーブル定義書 §7-2・計画 P5 §9-5）。

  **drizzle-kit は表単位の CHECK があると「表を作り直す」SQL を出す。**
  2026-09-04 に実測: `runs` に列 1 本を足す `generate` が
  `CREATE TABLE __new_runs` → `INSERT ... SELECT` → **`DROP TABLE runs`** →
  `RENAME` を出した。`asks` / `events` / `inbox` の 3 表が `runs.run_key` を
  参照しているので**これは適用できない**（先頭の `PRAGMA foreign_keys=OFF` も
  D1 では効かない）。

  **症状は「本番のデプロイで移行が落ちる」**か、最悪**通ってしまって
  子表の参照が壊れる**。目で読む規律を機械にも持たせる。
*/

const MIGRATIONS_DIR = path.join(
  import.meta.dirname,
  "../../../../packages/db/src/migrations",
);

const sqlFiles = (): readonly string[] =>
  readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();

/**
 * **コメントを外してから見る。** 規約は SQL の**文**に対するもので、
 * 「なぜ生成物を書き換えたか」を説明するコメントは禁じ手を引用してよい
 * （P3a §9-3 と同じ罠 —— 散文を錨にすると隣を読み始める）。
 */
const statementsOf = (name: string): string =>
  readFileSync(path.join(MIGRATIONS_DIR, name), "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

const journal = JSON.parse(
  readFileSync(path.join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8"),
) as { entries: readonly { idx: number; tag: string }[] };

describe("表を作り直す移行を混ぜない", () => {
  /*
    **これが本題。** 生成物をそのまま commit すると、ここで止まる。
    止まったら `ALTER TABLE ADD COLUMN` に書き換える —— SQLite は
    `ADD COLUMN` に**列単位の** CHECK を許すので、名前を明示した 1 文で足りる
    （禁じられているのは PRIMARY KEY / UNIQUE / GENERATED と、
    既定値が NULL でない NOT NULL）。
  */
  it.each(sqlFiles())("%s が表を DROP しない", (name) => {
    expect(statementsOf(name)).not.toMatch(/DROP\s+TABLE/i);
  });

  /** 作り直しの足跡（drizzle-kit は `__new_<table>` を作る）。 */
  it.each(sqlFiles())("%s が __new_ の一時表を作らない", (name) => {
    expect(statementsOf(name)).not.toContain("__new_");
  });

  /*
    **`PRAGMA foreign_keys` は D1 で効かない。** 生成物の先頭に付いてくるので、
    残っていること自体が「作り直しの SQL をそのまま持ってきた」合図になる。
  */
  it.each(sqlFiles())("%s が PRAGMA foreign_keys を触らない", (name) => {
    expect(statementsOf(name)).not.toMatch(/PRAGMA\s+foreign_keys/i);
  });
});

describe("journal とファイルが揃っている", () => {
  /*
    **手で書き換えるときに名前も変える**（生成名は `0005_perpetual_iceman` の
    ような無意味な語になる）。**journal の `tag` を直し忘れると、
    drizzle の次の diff が狂う。**
  */
  it("journal の tag が .sql の名前と一致する", () => {
    expect(journal.entries.map((entry) => entry.tag)).toEqual(
      sqlFiles().map((name) => name.replace(/\.sql$/, "")),
    );
  });

  it("idx が 0 から連番", () => {
    expect(journal.entries.map((entry) => entry.idx)).toEqual(
      journal.entries.map((_, index) => index),
    );
  });
});
