import { describe, expect, it } from "vitest";
import { checkFireUrl, isFireUrlAllowed } from "./fire.ts";

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
