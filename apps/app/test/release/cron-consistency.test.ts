import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
  cron の文字列が **3 か所**にある（計画 P8 §2-1・§7）。

    apps/app/src/worker/scheduled/crons.ts   CRONS（コードが分岐に使う値）
    apps/app/wrangler.jsonc                  triggers.crons（ローカル）
    packages/infra/alchemy.run.ts            crons（本番）

  **1 本にできない。** `wrangler.jsonc` は JSON でコードを import できず、
  `alchemy.run.ts` は Alchemy CLI の直接のエントリなので Worker のコードを
  import しない（`env-required.test.ts` と同じ事情）。

  **3 つとも文字列として読む。** `crons.ts` を import すれば型は付くが、
  release のテストは node のプールで走り、`tsconfig.release.json` は
  `src/` を含まない（含めると Worker の型が release 側へ流れ込む）——
  **同じやり方で 3 か所を読む**方が、片方だけ読み方が違うより漏れに気付きやすい
  （`run-status.test.ts` が 4 か所を同じ正規表現で読んでいるのと同じ理由）。

  **食い違ったときの壊れ方が最悪。** 登録側とコード側がずれると、
  `scheduled` は**どの分岐にも入らず何も起きない** —— 例外も出ず、
  「Gateway が起きない」「`queued` が畳まれない」が静かに続く。
  `test/scheduled/unknown-cron.test.ts` が `console.error` を出す側で、
  ここが**そもそも食い違わせない**側。
*/

const REPO_ROOT = path.join(import.meta.dirname, "../../../..");

const readSource = (relative: string): string =>
  readFileSync(path.join(REPO_ROOT, relative), "utf8");

/**
 * `crons` の配列の中の文字列リテラル。
 *
 * **鍵の名前を錨にする**（`crons`）。cron の式そのものを探しに行くと、
 * 散文やコメントに書いた同じ文字列に当たって「一致しているつもり」になる。
 *
 * なお **cron の式は JSDoc に書けない** —— 5 分ごとの式は `*` と `/` が並ぶので、
 * ブロックコメントをその場で閉じてしまう（ここで 1 度踏んだ）。
 */
const cronsIn = (source: string): readonly string[] => {
  const block = /crons"?:\s*\[([^\]]*)\]/.exec(source);
  if (block?.[1] === undefined) {
    throw new Error("crons の宣言が見つかりません");
  }
  return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
};

const CRONS_SOURCE = readSource("apps/app/src/worker/scheduled/crons.ts");

/** `export const NAME = "…";` の値。 */
const literalOf = (name: string): string => {
  const match = new RegExp(`const ${name}\\s*=\\s*"([^"]+)"`).exec(
    CRONS_SOURCE,
  );
  if (match?.[1] === undefined) {
    throw new Error(`${name} の宣言が見つかりません`);
  }
  return match[1];
};

/** `const CRONS = [CRON_EVERY_5_MIN] as const;` を値の一覧へ畳む。 */
const declaredCrons = (): readonly string[] => {
  const block = /const CRONS[^=]*=\s*\[([^\]]*)\]/.exec(CRONS_SOURCE);
  if (block?.[1] === undefined) {
    throw new Error("CRONS の宣言が見つかりません");
  }
  return [...block[1].matchAll(/([A-Z][A-Z0-9_]+)/g)].map((match) =>
    literalOf(match[1] ?? ""),
  );
};

const CODE = declaredCrons();
const WRANGLER = cronsIn(readSource("apps/app/wrangler.jsonc"));
const INFRA = cronsIn(readSource("packages/infra/alchemy.run.ts"));

describe("cron の文字列", () => {
  it("wrangler.jsonc（ローカル）がコードと一致する", () => {
    expect(WRANGLER).toEqual([...CODE]);
  });

  it("alchemy.run.ts（本番）がコードと一致する", () => {
    expect(INFRA).toEqual([...CODE]);
  });

  it("5 分ごと（要件 F-I2 の watchdog）", () => {
    expect(literalOf("CRON_EVERY_5_MIN")).toBe(["*", "5 * * * *"].join("/"));
  });

  /*
    **登録を増やしたら分岐も増やす。** 登録だけ増やすと、その cron が来たときに
    `unknown schedule` の `error` が 5 分ごとに出続ける（動くが騒がしい）。
  */
  it("登録している本数とコードが知っている本数が同じ", () => {
    expect(WRANGLER).toHaveLength(CODE.length);
    expect(INFRA).toHaveLength(CODE.length);
  });
});

describe("scheduled の分岐", () => {
  const INDEX = readSource("apps/app/src/worker/index.ts");

  /** **文字列を直に書かない。** 書くと 4 か所目ができる。 */
  it("index.ts が cron の文字列を直に持たない", () => {
    expect(INDEX).not.toContain('"*/5');
    expect(INDEX).toContain("CRON_EVERY_5_MIN");
  });

  /*
    **`Promise.allSettled` を使う**（`all` ではない）。Gateway の起こし直しが
    失敗しても掃除は走らせたい —— `all` にすると片方の reject で抜ける。
  */
  it("2 つの仕事を allSettled で並べている", () => {
    expect(INDEX).toContain("Promise.allSettled");
    expect(INDEX).not.toContain("Promise.all([");
  });

  /** **`waitUntil` に載せる。** 待たずに抜けると書き込みの途中で切られる。 */
  it("waitUntil に載せている", () => {
    expect(INDEX).toMatch(/ctx\.waitUntil\(\s*Promise\.allSettled/);
  });

  /** **既定の分岐で必ず声を上げる**（要件 `N-7`）。 */
  it("default で console.error を出す", () => {
    const scheduled = /const scheduled[\s\S]*?\n};/.exec(INDEX)?.[0] ?? "";

    expect(scheduled).toContain("default:");
    expect(scheduled).toContain("console.error");
  });
});
