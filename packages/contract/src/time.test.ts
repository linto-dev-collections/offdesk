import { describe, expect, it } from "vitest";
import { formatJst, formatJstDate } from "./time.ts";

/** `2026-09-03T09:00:00Z` = JST 2026-09-03 18:00。 */
const AFTERNOON_UTC = Date.UTC(2026, 8, 3, 9, 0, 0);

describe("formatJst", () => {
  it("UTC の epoch ミリ秒を JST の壁時計で表す", () => {
    expect(formatJst(AFTERNOON_UTC)).toBe("2026-09-03 18:00");
  });

  it("JST の 0 時ちょうど（UTC の前日 15:00）", () => {
    expect(formatJst(Date.UTC(2026, 8, 2, 15, 0, 0))).toBe("2026-09-03 00:00");
  });

  it("JST の 0 時の 1 ミリ秒前は前日の 23:59", () => {
    expect(formatJst(Date.UTC(2026, 8, 2, 15, 0, 0) - 1)).toBe(
      "2026-09-02 23:59",
    );
  });

  it("UTC 側で日付が変わっても JST 側は同じ日のまま", () => {
    expect(formatJst(Date.UTC(2026, 8, 3, 23, 59, 0))).toBe("2026-09-04 08:59");
    expect(formatJst(Date.UTC(2026, 8, 4, 0, 0, 0))).toBe("2026-09-04 09:00");
  });

  it("年をまたぐ", () => {
    expect(formatJst(Date.UTC(2026, 11, 31, 15, 0, 0))).toBe(
      "2027-01-01 00:00",
    );
  });

  it("epoch そのもの（1970-01-01T00:00:00Z）は JST の 9 時", () => {
    expect(formatJst(0)).toBe("1970-01-01 09:00");
  });

  /*
    夏時間を持つタイムゾーンなら 3 月と 9 月で結果が変わる。JST は変わらない
    ——「固定オフセットで計算してよい」という前提そのものを検査する。
  */
  it("夏の日付でも冬の日付でもオフセットは +9 のまま", () => {
    expect(formatJst(Date.UTC(2026, 6, 1, 15, 0, 0))).toBe("2026-07-02 00:00");
    expect(formatJst(Date.UTC(2027, 0, 1, 15, 0, 0))).toBe("2027-01-02 00:00");
  });
});

describe("formatJstDate", () => {
  it("日付だけを返す", () => {
    expect(formatJstDate(AFTERNOON_UTC)).toBe("2026-09-03");
  });

  it("月と日は 2 桁に揃える", () => {
    expect(formatJstDate(Date.UTC(2026, 0, 1, 0, 0, 0))).toBe("2026-01-01");
  });
});
