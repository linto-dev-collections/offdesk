import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
  Gateway の「状態の一覧」と「fatal の直し方」が **2 か所ずつ**にある。

    packages/domain/src/gateway.ts     GatewayState（遷移に要る値を抱えた合併型）
    packages/contract/src/gateway.ts   GATEWAY_STATES（外へ出せる 5 つ）

    packages/domain/src/gateway.ts     FATAL_CLOSE_CODES（張り直しても直らない close code）
    packages/contract/src/gateway.ts   FATAL_HINTS（人へ出す直し方）

  **1 本にできない。** `packages/contract` は依存の終着点なので下流から型を
  貰えず（要件 `I-8`・`contract-is-terminal`）、domain は API の契約に依存できない。
  `RUN_STATUSES` が 4 か所にあるのと同じ事情（`run-status.test.ts`）。

  **食い違ったときの壊れ方が読みにくい。**

    状態を domain にだけ足す → `GatewayStatus.parse` が縁で落ちて
                               `/gateway/status` が 500（状態の名前は出ない）
    close code を domain にだけ足す → `fatal` になるが**直し方が出ない** ——
                               「人が直すまで戻らない」状態で、
                               何をすれば戻るのかが画面に出ない（要件 `F-I4`）
*/

const REPO_ROOT = path.join(import.meta.dirname, "../../../..");

const readSource = (relative: string): string =>
  readFileSync(path.join(REPO_ROOT, relative), "utf8");

const DOMAIN = readSource("packages/domain/src/gateway.ts");
const CONTRACT = readSource("packages/contract/src/gateway.ts");

/** `const NAME ... = [ ... ]` の中の数値リテラル。 */
const numberLiterals = (
  source: string,
  constant: string,
): readonly number[] => {
  const block = new RegExp(
    `const ${constant}[^=]*=\\s*\\[([\\s\\S]*?)\\]`,
  ).exec(source);
  if (block?.[1] === undefined) {
    throw new Error(`${constant} の宣言が見つかりません`);
  }
  return [...block[1].matchAll(/\b(\d{4})\b/g)].map((match) =>
    Number(match[1]),
  );
};

/** `const NAME ... = [ ... ]` の中の文字列リテラル。 */
const arrayLiterals = (source: string, constant: string): readonly string[] => {
  const block = new RegExp(
    `const ${constant}[^=]*=\\s*\\[([\\s\\S]*?)\\]`,
  ).exec(source);
  if (block?.[1] === undefined) {
    throw new Error(`${constant} の宣言が見つかりません`);
  }
  return [...block[1].matchAll(/"([a-z_]+)"/g)].map((match) => match[1] ?? "");
};

/** `export type GatewayState = | Readonly<{ kind: "idle" }> | …` の `kind`。 */
const stateKinds = (): readonly string[] => {
  const block = /export type GatewayState =([\s\S]*?)\nexport /.exec(DOMAIN);
  if (block?.[1] === undefined) {
    throw new Error("GatewayState の宣言が見つかりません");
  }
  return [...block[1].matchAll(/kind: "([a-z]+)"/g)].map(
    (match) => match[1] ?? "",
  );
};

/** `const FATAL_HINTS: … = { no_token: "…", close_4004: "…", … }` の鍵。 */
const hintKeys = (): readonly string[] => {
  const block = /const FATAL_HINTS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(CONTRACT);
  if (block?.[1] === undefined) {
    throw new Error("FATAL_HINTS の宣言が見つかりません");
  }
  return [...block[1].matchAll(/^ {2}([a-z0-9_]+):/gm)].map(
    (match) => match[1] ?? "",
  );
};

describe("Gateway の状態の一覧", () => {
  it("契約の 5 つが domain の kind と一致する", () => {
    expect(arrayLiterals(CONTRACT, "GATEWAY_STATES")).toEqual(stateKinds());
  });

  it("5 状態（要件 F-I1〜F-I5 の状態機械）", () => {
    expect(stateKinds()).toEqual([
      "idle",
      "connecting",
      "live",
      "backoff",
      "fatal",
    ]);
  });
});

describe("fatal の直し方", () => {
  const codes = numberLiterals(DOMAIN, "FATAL_CLOSE_CODES");
  const keys = hintKeys();

  /** Discord のドキュメントの Reconnect = false 全部（計画 P4 §3-2 の脚注）。 */
  it("張り直しても直らない close code が 6 つ", () => {
    expect(codes).toEqual([4004, 4010, 4011, 4012, 4013, 4014]);
  });

  /*
    **`fatal` になれる理由すべてに直し方がある。** 既定の文（生の理由 ＋
    「張り直してみてください」）に落ちても止まらないが、
    **設定を直さないと戻らない失敗で「張り直せ」と言うのは嘘**になる。
  */
  it.each(numberLiterals(DOMAIN, "FATAL_CLOSE_CODES"))(
    "close_%i に専用の文言がある",
    (code) => {
      expect(keys).toContain(`close_${code}`);
    },
  );

  /*
    **`no_token` も `fatal` の理由。** close code ではなく
    `misconfigured` 入力から来る（`DISCORD_BOT_TOKEN` が空）ので、
    上の突き合わせでは拾えない。
  */
  it("no_token にも文言がある", () => {
    expect(keys).toContain("no_token");
  });

  it("文言に使っていない鍵が残っていない", () => {
    const expected = new Set(["no_token", ...codes.map((c) => `close_${c}`)]);

    expect(new Set(keys)).toEqual(expected);
  });
});
