import { describe, expect, it } from "vitest";
import { bearerMatches, constantTimeEqual } from "./constant-time-equal.ts";

describe("constantTimeEqual", () => {
  it("一致する", () => {
    expect(constantTimeEqual("sk-ant-oat01-abc", "sk-ant-oat01-abc")).toBe(
      true,
    );
  });

  it("1 文字違いで一致しない", () => {
    expect(constantTimeEqual("sk-ant-oat01-abc", "sk-ant-oat01-abd")).toBe(
      false,
    );
  });

  it("長さが違えば一致しない", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("abcd", "abc")).toBe(false);
  });

  it("空どうしは一致する（呼ぶ側が未設定を先に落とす）", () => {
    expect(constantTimeEqual("", "")).toBe(true);
  });

  it("先頭が一致していても最後まで見る", () => {
    expect(constantTimeEqual("aaaaaaaab", "aaaaaaaac")).toBe(false);
  });

  it("非 ASCII でも一致・不一致が正しい", () => {
    expect(constantTimeEqual("鍵🔑", "鍵🔑")).toBe(true);
    expect(constantTimeEqual("鍵🔑", "鍵🔒")).toBe(false);
  });
});

describe("bearerMatches", () => {
  const TOKEN = "offdesk-token-0123456789abcdef";

  it("正しいトークンで通る", () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  it("1 文字違いで通らない", () => {
    expect(bearerMatches(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
  });

  /*
    plans/security.md 脅威 2。**未設定は全拒否。**
    `Authorization: Bearer ` （値なし）が空文字の設定と一致して全開になる形を残さない。
  */
  it.each([undefined, "", "   "])(
    "設定が %o なら誰も通らない",
    (configured) => {
      expect(bearerMatches("Bearer ", configured)).toBe(false);
      expect(bearerMatches("Bearer anything", configured)).toBe(false);
      expect(bearerMatches(undefined, configured)).toBe(false);
    },
  );

  it("Bearer 以外の形は通らない", () => {
    expect(bearerMatches(TOKEN, TOKEN)).toBe(false);
    expect(bearerMatches(`bearer ${TOKEN}`, TOKEN)).toBe(false);
    expect(bearerMatches(`Basic ${TOKEN}`, TOKEN)).toBe(false);
  });

  it("値の前後の空白は落としてから比べる", () => {
    expect(bearerMatches(`Bearer  ${TOKEN} `, TOKEN)).toBe(true);
    expect(bearerMatches(`Bearer ${TOKEN}`, ` ${TOKEN}\n`)).toBe(true);
  });

  it("ヘッダが無ければ通らない", () => {
    expect(bearerMatches(undefined, TOKEN)).toBe(false);
  });
});
