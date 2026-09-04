import { describe, expect, it } from "vitest";
import {
  formatDuration,
  formatJst,
  formatJstDate,
  formatRelativeJst,
} from "./time.ts";

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

describe("formatRelativeJst", () => {
  const NOW = Date.UTC(2026, 8, 5, 3, 0, 0);
  const ago = (ms: number): number => NOW - ms;

  const SECOND = 1000;
  const MINUTE = 60 * SECOND;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  it("1 分未満は「たった今」", () => {
    expect(formatRelativeJst(NOW, NOW)).toBe("たった今");
    expect(formatRelativeJst(ago(59 * SECOND), NOW)).toBe("たった今");
  });

  it("分・時間・日で単位が切り替わる", () => {
    expect(formatRelativeJst(ago(MINUTE), NOW)).toBe("1 分前");
    expect(formatRelativeJst(ago(59 * MINUTE), NOW)).toBe("59 分前");
    expect(formatRelativeJst(ago(HOUR), NOW)).toBe("1 時間前");
    expect(formatRelativeJst(ago(23 * HOUR), NOW)).toBe("23 時間前");
    expect(formatRelativeJst(ago(DAY), NOW)).toBe("1 日前");
    expect(formatRelativeJst(ago(400 * DAY), NOW)).toBe("400 日前");
  });

  it("切り上げない（1 時間 59 分は「1 時間前」）", () => {
    expect(formatRelativeJst(ago(HOUR + 59 * MINUTE), NOW)).toBe("1 時間前");
  });

  /*
    **未来は「たった今」に倒す**（`created_at` は D1 側の時計で、
    端末の時計が数秒ずれているだけで「-1 分前」が出る）。
  */
  it("未来の時刻でも負の数を出さない", () => {
    expect(formatRelativeJst(NOW + 5 * MINUTE, NOW)).toBe("たった今");
  });
});

describe("formatDuration", () => {
  const SECOND = 1000;
  const MINUTE = 60 * SECOND;
  const HOUR = 60 * MINUTE;

  /** **「0 秒」を出さない。** 起動に失敗した run と見分けが付かなくなる。 */
  it("1 秒未満は「< 1 秒」", () => {
    expect(formatDuration(0)).toBe("< 1 秒");
    expect(formatDuration(999)).toBe("< 1 秒");
  });

  it("秒・分・時間で単位が切り替わる", () => {
    expect(formatDuration(SECOND)).toBe("1 秒");
    expect(formatDuration(59 * SECOND)).toBe("59 秒");
    expect(formatDuration(MINUTE)).toBe("1 分");
    expect(formatDuration(59 * MINUTE)).toBe("59 分");
    expect(formatDuration(HOUR)).toBe("1 時間");
  });

  it("時間には分を添える（ちょうどなら添えない）", () => {
    expect(formatDuration(HOUR + 5 * MINUTE)).toBe("1 時間 5 分");
    expect(formatDuration(2 * HOUR)).toBe("2 時間");
    expect(formatDuration(15 * HOUR + 1 * MINUTE)).toBe("15 時間 1 分");
  });

  /** 実測 15 分 01 秒（要件 §10-5 の握り）。 */
  it("握りの上限（15 分 01 秒）が読める形になる", () => {
    expect(formatDuration(15 * MINUTE + SECOND)).toBe("15 分");
  });
});
