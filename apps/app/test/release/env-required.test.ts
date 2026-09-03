import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
  **同じ一覧が 2 か所にある**（要件 §10-6・計画 P1 §3-7）。

    apps/app/src/worker/env.ts          PRODUCTION_REQUIRED_ENV_NAMES（唯一の定義）
    packages/infra/alchemy.run.ts       その写し

  写しになっているのは、`alchemy.run.ts` が Alchemy CLI の直接のエントリで、
  Worker のコード（`D1Database` の型に依存する）を import できないため。

  **片方だけ足すと黙って壊れる。** env.ts だけに足すと「deploy は通るのに起動時に
  落ちる」、alchemy.run.ts だけに足すと「deploy は止まるのに Worker は要求しない」。
  ここが緑である限り、その食い違いは起きない。

  正規表現でソースを読むのは、**`alchemy.run.ts` を import すると
  `ALCHEMY_PASSWORD` の検査で落ちる**ため（あれは実行されることを前提にしている）。
*/

const REPO_ROOT = path.join(import.meta.dirname, "../../../..");

const readSource = (relative: string): string =>
  readFileSync(path.join(REPO_ROOT, relative), "utf8");

/**
 * `PRODUCTION_REQUIRED_ENV_NAMES ... = [ ... ]` の中の文字列リテラルを拾う。
 *
 * **`= [` で区切るのが要点。** `[^[]*\[` にすると `readonly string[]` の
 * `[` を先に掴んでしまい、空配列が返って**テストが常に通る**（実測で踏んだ）。
 */
const requiredNamesIn = (source: string): readonly string[] => {
  const block = /PRODUCTION_REQUIRED_ENV_NAMES[^=]*=\s*\[([\s\S]*?)\]/.exec(
    source,
  );
  if (block?.[1] === undefined) {
    throw new Error("PRODUCTION_REQUIRED_ENV_NAMES の宣言が見つかりません");
  }
  return [...block[1].matchAll(/"([A-Z0-9_]+)"/g)].map(
    (match) => match[1] ?? "",
  );
};

const workerNames = requiredNamesIn(readSource("apps/app/src/worker/env.ts"));
const infraNames = requiredNamesIn(readSource("packages/infra/alchemy.run.ts"));

describe("本番で必須の環境変数の一覧", () => {
  it("env.ts と alchemy.run.ts で一致する", () => {
    expect(infraNames).toEqual(workerNames);
  });

  it("空でない（P1 以降は必ず何か入っている）", () => {
    expect(workerNames.length).toBeGreaterThan(0);
  });
});

describe("全ステージ必須の 2 つは両方で個別に見ている", () => {
  /*
    `BETTER_AUTH_SECRET` と `AUTH_ALLOWED_EMAILS` は prod 以外でも必須なので、
    上の一覧ではなく個別の分岐で見る。**一覧に入れると欠落の個数がずれる**
    （`assertEnv` が二重に数える）。
  */
  const alwaysRequired = ["BETTER_AUTH_SECRET", "AUTH_ALLOWED_EMAILS"] as const;

  it("一覧には入っていない", () => {
    for (const name of alwaysRequired) {
      expect(workerNames).not.toContain(name);
      expect(infraNames).not.toContain(name);
    }
  });

  it("env.ts が個別に検査している", () => {
    const source = readSource("apps/app/src/worker/env.ts");

    for (const name of alwaysRequired) {
      expect(source).toContain(`isBlank(env.${name})`);
    }
  });

  it("alchemy.run.ts が個別に検査している", () => {
    const source = readSource("packages/infra/alchemy.run.ts");

    for (const name of alwaysRequired) {
      expect(source).toContain(`"${name}"`);
    }
  });
});

describe(".env.example に名前が並んでいる", () => {
  /*
    **設定する人が読むのは `.env.example`。** コードに足して例に足し忘れると、
    「本番で落ちるまで気付かない」形になる。
  */
  it("必須の名前が全部書かれている", () => {
    const example = readSource("apps/app/.env.example");

    for (const name of [
      ...workerNames,
      "BETTER_AUTH_SECRET",
      "AUTH_ALLOWED_EMAILS",
    ]) {
      expect(example).toContain(name);
    }
  });

  it("CI のワークフローが必須の名前を渡している", () => {
    const workflow = readSource(".github/workflows/ci.yml");

    for (const name of [
      ...workerNames,
      "BETTER_AUTH_SECRET",
      "AUTH_ALLOWED_EMAILS",
    ]) {
      expect(workflow).toContain(`${name}:`);
    }
  });
});
