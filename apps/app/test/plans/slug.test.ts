import { describe, expect, it } from "vitest";
import { createSlugger } from "../../src/worker/plans/slug.ts";

/*
  見出しの id（要件 `F-E7`・計画 P6 §6）。

  **値で固める。** 計画は `[§3.1](#31-キーが-confluence-と違う)` で自分を
  指しているので、ここが 1 文字動くと**リンクを踏んでも飛ばない文書**になる。
  値は `github-slugger` 2.0.0 の実測（2026-09-04）。
*/

const slug = (text: string): string => createSlugger()(text);

describe("GitHub と同じ規則", () => {
  it.each([
    ["3.1 キーが Confluence と違う", "31-キーが-confluence-と違う"],
    ["4-2. パスの正規化（脅威 8）", "4-2-パスの正規化脅威-8"],
    ["9. 踏みやすい落とし穴", "9-踏みやすい落とし穴"],
    ["**強調** と `code`", "強調-と-code"],
    ["UPPER Case", "upper-case"],
  ])("%s → %s", (text, expected) => {
    expect(slug(text)).toBe(expected);
  });

  /*
    **ダッシュの扱いが引っ掛かる。** 半角 `-` は残るが `—`（em dash）と `–` は
    記号として消える。素朴に「`\p{Pd}` を残す」と書くとここがずれて、
    リンクを踏んでも飛ばない見出しができる。
  */
  it.each([
    ["半角 - は残る", "半角---は残る"],
    ["em — dash", "em--dash"],
    ["A–B", "ab"],
    ["P6 — 実装計画の配布", "p6--実装計画の配布"],
  ])("%s → %s", (text, expected) => {
    expect(slug(text)).toBe(expected);
  });

  it.each([
    ["全角　空白", "全角空白"],
    ["絵文字 🏁 つき", "絵文字--つき"],
    ["a  b   c", "a--b---c"],
  ])("%s → %s", (text, expected) => {
    expect(slug(text)).toBe(expected);
  });
});

describe("重複", () => {
  it("2 つ目に -1 が付く", () => {
    const slugger = createSlugger();

    expect(slugger("同じ見出し")).toBe("同じ見出し");
    expect(slugger("同じ見出し")).toBe("同じ見出し-1");
    expect(slugger("同じ見出し")).toBe("同じ見出し-2");
  });

  /*
    **文書ごとに作る。** 使い回すと 2 つ目の文書の最初の見出しに `-1` が付き、
    その文書の中の `[§1](#…)` が全部ずれる。
  */
  it("別の slugger は数え直す", () => {
    createSlugger()("同じ見出し");

    expect(createSlugger()("同じ見出し")).toBe("同じ見出し");
  });
});
