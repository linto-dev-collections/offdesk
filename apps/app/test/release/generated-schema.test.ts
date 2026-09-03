import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
  `packages/db/src/schema/auth.ts` は `auth generate` の生成物で、**手を入れない**
  約束になっている（テーブル定義書 §2）。

  約束を守る仕組みは 2 つ:

    1. `biome.json` の `files.includes` から外す（整形で動かない）
    2. ここ —— **再生成して差分が出ないことを確かめる**

  1 だけだと「整形はされないが人が編集できる」ので、2 が要る。
  差分が出たら、`auth generate` を回して出た結果を commit する（手で直した内容は捨てる。それが「生成物」の意味）。
*/

const REPO_ROOT = path.join(import.meta.dirname, "../../../..");
const SCHEMA_PATH = path.join(REPO_ROOT, "packages/db/src/schema/auth.ts");

const readSchema = (): string => readFileSync(SCHEMA_PATH, "utf8");

/**
 * 宣言されている表名。
 *
 * 改行に依存させない。索引を持つ表は `sqliteTable(\n  "sessions",` と複数行で出るので、`sqliteTable("sessions"` を探すと見つからない（実測で踏んだ）。
 */
const tableNamesIn = (schema: string): readonly string[] =>
  [...schema.matchAll(/sqliteTable\(\s*"([a-z_]+)"/g)].map(
    (match) => match[1] ?? "",
  );

describe("生成物の同一性", () => {
  it("auth generate を再実行しても差分が出ない", () => {
    const before = readSchema();

    execFileSync("pnpm", ["-F", "@offdesk/auth", "auth:generate"], {
      cwd: REPO_ROOT,
      stdio: "pipe",
    });

    const after = readSchema();

    /*
      **落ちたとき、ファイルは `auth generate` が出した内容のまま残る。**
      戻さないのは意図で、直し方が「そのまま commit する」になるため
      （手で直した内容は捨てる。それが「生成物」の意味）。
    */
    expect(after).toBe(before);
  });
});

describe("生成物の中身", () => {
  /*
    **表名が複数形であること**（テーブル定義書 §2）。`usePlural: true` を
    落とすと単数形になり、認証 4 表すべての改名マイグレーションになる。
  */
  it("表名が複数形（users / sessions / accounts / verifications）", () => {
    expect([...tableNamesIn(readSchema())].sort()).toEqual([
      "accounts",
      "sessions",
      "users",
      "verifications",
    ]);
  });

  /*
    **時刻は epoch ミリ秒**（テーブル定義書 §3-1）。offdesk 所有の 7 表と
    揃っていないと、画面で 2 種類の時刻表現を扱うことになる。
  */
  it("時刻が timestamp_ms", () => {
    expect(readSchema()).toContain('{ mode: "timestamp_ms" }');
  });

  /*
    **認証 4 表の `ON DELETE CASCADE` はライブラリの生成物なので変えない。**
    offdesk 所有の 7 表には 1 つも無い（テーブル定義書 §3-4）。
    ここが変わったら、`users` を作り直す手順（§7-3）の前提が動く。
  */
  it("sessions と accounts の user_id が cascade", () => {
    const schema = readSchema();
    const cascades = schema.match(/onDelete: "cascade"/g) ?? [];

    expect(cascades.length).toBe(2);
  });
});
