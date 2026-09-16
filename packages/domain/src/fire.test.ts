import { describe, expect, it } from "vitest";
import {
  checkFireUrl,
  isFireUrlAllowed,
  routineIdOf,
  sameRoutine,
} from "./fire.ts";

const REAL = "https://api.anthropic.com/v1/claude_code/routines/trig_abc/fire";

describe("isFireUrlAllowed", () => {
  it("本物の fire URL は通る", () => {
    expect(isFireUrlAllowed(REAL)).toBe(true);
  });

  /*
    plans/security.md 脅威 3。**1 文字違いでも資格情報の持ち出しが成立する**ので、
    ここは「似ている」を全部落とす。落ちなくなったらこの層は無いのと同じ。
  */
  it.each([
    ["ホストの 1 文字違い", "https://api.anthropic.co/v1/fire"],
    ["部分文字列で騙す", "https://api.anthropic.com.evil.example/v1/fire"],
    ["サブドメインを足す", "https://evil.api.anthropic.com/v1/fire"],
    ["別ホスト", "https://evil.example.com/v1/fire"],
    ["http", "http://api.anthropic.com/v1/fire"],
    ["利用者情報で騙す", "https://api.anthropic.com@evil.example/v1/fire"],
    ["前に空白", " https://api.anthropic.com/v1/fire"],
    ["スキームだけ", "api.anthropic.com/v1/fire"],
    ["空", ""],
  ])("%s は落ちる: %s", (_label, url) => {
    expect(isFireUrlAllowed(url)).toBe(false);
  });

  it("末尾のスラッシュまでが前提（ホスト名の途中で切らない）", () => {
    expect(isFireUrlAllowed("https://api.anthropic.comx/v1/fire")).toBe(false);
  });
});

describe("checkFireUrl", () => {
  it("通る URL なら null", () => {
    expect(checkFireUrl(REAL)).toBeNull();
  });

  it("落ちた理由に URL そのものを載せない（脅威 12）", () => {
    const problem = checkFireUrl("https://evil.example.com/v1/fire");

    expect(problem).not.toBeNull();
    expect(problem?.message).not.toContain("evil.example.com");
  });
});

/*
  **トークンは routine ごと**（`fire` のドキュメント: "The bearer token is scoped
  to a single routine"）。指す先が変わればいま持っているトークンは必ず通らないので、
  画面はそれを保存の前に止める（`updateProject`）。
*/
describe("routineIdOf", () => {
  const base = "https://api.anthropic.com/v1/claude_code/routines";

  it.each([
    [`${base}/trig_01ABC/fire`, "trig_01ABC"],
    [`${base}/trig_01ABC/fire?x=1`, "trig_01ABC"],
    [`${base}/trig_01ABC`, "trig_01ABC"],
  ])("%s → %s", (url, expected) => {
    expect(routineIdOf(url)).toBe(expected);
  });

  it.each(["https://api.anthropic.com/v1/messages", `${base}/`, ""])(
    "読めない形（%o）は null",
    (url) => {
      expect(routineIdOf(url)).toBeNull();
    },
  );
});

describe("sameRoutine", () => {
  const fire = (id: string): string =>
    `https://api.anthropic.com/v1/claude_code/routines/${id}/fire`;

  it("同じ識別子なら同じ", () => {
    expect(sameRoutine(fire("trig_01A"), fire("trig_01A"))).toBe(true);
  });

  it("末尾のクエリが違っても同じ", () => {
    expect(sameRoutine(fire("trig_01A"), `${fire("trig_01A")}?v=2`)).toBe(true);
  });

  it("識別子が違えば違う", () => {
    expect(sameRoutine(fire("trig_01A"), fire("trig_01B"))).toBe(false);
  });

  /*
    **読めない形を「同じ」に倒さない。** 倒すと、URL の形が変わった日に
    この検査が静かに無効になる（症状は「トークンだけ古いまま残る」）。
  */
  it("識別子が読めなければ URL 全体で比べる", () => {
    const odd = "https://api.anthropic.com/v1/other";

    expect(sameRoutine(odd, odd)).toBe(true);
    expect(sameRoutine(odd, `${odd}/x`)).toBe(false);
    expect(sameRoutine(odd, fire("trig_01A"))).toBe(false);
  });
});
