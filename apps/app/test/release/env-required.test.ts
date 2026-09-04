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
 * `const NAME ... = [ ... ]` の中の文字列リテラルを拾う。
 *
 * **`= [` で区切るのが要点。** `[^[]*\[` にすると `readonly string[]` の
 * `[` を先に掴んでしまい、空配列が返って**テストが常に通る**（実測で踏んだ）。
 *
 * **`const` から始めるのも要点**（2026-09-04 に踏んだ）。名前だけを錨にすると、
 * **同じ名前が散文の中に出てきた時点で一致してしまう** —— `env.ts` の
 * `WorkerEnv` に「`ENDPOINT_GATED_ENV_NAMES` にも入れない」という why を書いた瞬間、
 * そこから次の `= [` までを掴んで**隣の配列を読み始めた**（一致はするので
 * 「空で常に緑」ではなく「別の一覧と比べて常に赤」になった）。
 * 宣言だけを錨にすれば、コメントに名前を書いても壊れない。
 */
const namesIn = (source: string, constant: string): readonly string[] => {
  const block = new RegExp(
    `const ${constant}[^=]*=\\s*\\[([\\s\\S]*?)\\]`,
  ).exec(source);
  if (block?.[1] === undefined) {
    throw new Error(`${constant} の宣言が見つかりません`);
  }
  return [...block[1].matchAll(/"([A-Z0-9_]+)"/g)].map(
    (match) => match[1] ?? "",
  );
};

const WORKER_ENV = readSource("apps/app/src/worker/env.ts");
const INFRA = readSource("packages/infra/alchemy.run.ts");

const workerNames = namesIn(WORKER_ENV, "PRODUCTION_REQUIRED_ENV_NAMES");
const infraNames = namesIn(INFRA, "PRODUCTION_REQUIRED_ENV_NAMES");

const workerGated = namesIn(WORKER_ENV, "ENDPOINT_GATED_ENV_NAMES");
const infraGated = namesIn(INFRA, "ENDPOINT_GATED_ENV_NAMES");

describe("本番で必須の環境変数の一覧", () => {
  it("env.ts と alchemy.run.ts で一致する", () => {
    expect(infraNames).toEqual(workerNames);
  });

  it("空でない（P1 以降は必ず何か入っている）", () => {
    expect(workerNames.length).toBeGreaterThan(0);
  });
});

/*
  **宣言はするが `assertEnv` では要求しない一覧**（P2）。
  欠けたときに落ちるのは入口だけなので `assertEnv` に入れないが、
  **渡し忘れると Discord 経路が黙って動かない**ので、一覧としては揃えて見張る。
*/
describe("入口で fail-closed にする環境変数の一覧", () => {
  it("env.ts と alchemy.run.ts で一致する", () => {
    expect(infraGated).toEqual(workerGated);
  });

  it("空でない（P2 以降は必ず何か入っている）", () => {
    expect(workerGated.length).toBeGreaterThan(0);
  });

  /*
    **2 つの一覧が重ならないこと。** 重なると `assertEnv` が必須として数えて
    しまい、「1 つ足りないだけで全リクエストが 500」に戻る。
  */
  it("必須の一覧と重なっていない", () => {
    for (const name of workerGated) {
      expect(workerNames).not.toContain(name);
    }
  });

  it("alchemy.run.ts が bindings に渡している", () => {
    for (const name of workerGated) {
      expect(INFRA).toMatch(
        new RegExp(`${name}: (var|secret)Of\\("${name}"\\)`),
      );
    }
  });

  it("WorkerEnv に型として宣言されている", () => {
    for (const name of workerGated) {
      expect(WORKER_ENV).toMatch(new RegExp(`${name}: string;`));
    }
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
      ...workerGated,
      "BETTER_AUTH_SECRET",
      "AUTH_ALLOWED_EMAILS",
    ]) {
      expect(example).toContain(name);
    }
  });

  /** **コメントアウトされたままにしない。** `# NAME=` は設定した気にさせる。 */
  it("コメントアウトされていない", () => {
    const example = readSource("apps/app/.env.example");

    for (const name of [...workerNames, ...workerGated]) {
      expect(example).toMatch(new RegExp(`^${name}=`, "m"));
    }
  });

  it("CI のワークフローが必須の名前を渡している", () => {
    const workflow = readSource(".github/workflows/ci.yml");

    for (const name of [
      ...workerNames,
      ...workerGated,
      "BETTER_AUTH_SECRET",
      "AUTH_ALLOWED_EMAILS",
    ]) {
      expect(workflow).toContain(`${name}:`);
    }
  });
});
