import { describe, expect, it } from "vitest";
import { elapsedMs, hasElapsed } from "./time.ts";

const NOW = Date.UTC(2026, 8, 3, 9, 0, 0);
const MINUTE = 60_000;

describe("elapsedMs", () => {
  it("経過を返す", () => {
    expect(elapsedMs(NOW - 3 * MINUTE, NOW)).toBe(3 * MINUTE);
  });

  it("未来の時刻を渡すと負になる（呼び手が判断する）", () => {
    expect(elapsedMs(NOW + MINUTE, NOW)).toBe(-MINUTE);
  });
});

describe("hasElapsed", () => {
  it("窓より短ければまだ", () => {
    expect(hasElapsed(NOW - MINUTE + 1, NOW, MINUTE)).toBe(false);
  });

  it("窓ちょうどは「経った」に含める", () => {
    expect(hasElapsed(NOW - MINUTE, NOW, MINUTE)).toBe(true);
  });

  it("窓を越えていれば経った", () => {
    expect(hasElapsed(NOW - MINUTE - 1, NOW, MINUTE)).toBe(true);
  });

  it("窓が 0 なら常に経った", () => {
    expect(hasElapsed(NOW, NOW, 0)).toBe(true);
  });
});
