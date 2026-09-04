import { describe, expect, it } from "vitest";
import { formatBytes } from "./bytes.ts";

/*
  計画の合計サイズ（計画 P7b §3-1）。

  **上限を伝える文と同じ単位で書く。** `publish-plan.sh` は「1MB まで」
  「8MB まで」と案内するので、1024 で刻んで KB / MB と書く ——
  KiB / MiB に直すと、画面の数字と口の案内が食い違って見える。
*/

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [1, "1 B"],
    [1023, "1023 B"],
    [1024, "1 KB"],
    [231_647, "226.2 KB"],
    [1024 * 1024, "1 MB"],
    [8 * 1024 * 1024, "8 MB"],
    [1024 * 1024 * 1024, "1 GB"],
  ])("%i → %s", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });

  /** **1 桁残す。** 整数に丸めると 1.4MB と 1.5MB の差が消える。 */
  it("小数は 1 桁だけ残す", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1434)).toBe("1.4 KB");
  });

  /** GB より上は用意しない（1 計画 8MB が上限なので、そこまで届かない）。 */
  it("GB を超えても GB で出す", () => {
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe("5 GB");
  });

  /*
    **負の数と小数を素で通さない。** `total_bytes` は `plans_counts_ck` が
    `>= 0` を守っているが、この関数は控えを受けるだけなので自分で倒す
    （`-1 B` が画面に出ると、DDL が壊れているのか表示が壊れているのか読めない）。
  */
  it.each([
    [-1, "0 B"],
    [1.9, "1 B"],
  ])("%s → %s（自分で倒す）", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});
