import { describe, expect, it } from "vitest";
import { gateEmail, parseAllowedEmails } from "./allowlist.ts";

const ALLOWED = parseAllowedEmails("owner@example.com");

describe("parseAllowedEmails", () => {
  it("`,` で割って正規化する", () => {
    expect(parseAllowedEmails("A@x.com, B@y.com")).toEqual([
      "a@x.com",
      "b@y.com",
    ]);
  });

  it("空要素を落とす", () => {
    expect(parseAllowedEmails("a@x.com,,  ,b@y.com")).toEqual([
      "a@x.com",
      "b@y.com",
    ]);
  });

  /*
    **空文字が残ると「空文字のメールを許可」になる。** 空文字どうしは一致するので、
    メールを持たない ID 連携が全部通る（要件 I-2 が崩れる）。
  */
  it("空文字だけなら空配列", () => {
    expect(parseAllowedEmails("")).toEqual([]);
    expect(parseAllowedEmails("   ")).toEqual([]);
    expect(parseAllowedEmails(",,,")).toEqual([]);
  });
});

describe("gateEmail — allowlist が空なら誰も通さない（要件 I-2）", () => {
  it("空 allowlist では許可されているはずのメールでも通さない", () => {
    expect(gateEmail([], "owner@example.com")).toEqual({
      allowed: false,
      reason: "許可リストが未設定です",
    });
  });

  it("空 allowlist かつメール未設定でも通さない", () => {
    expect(gateEmail([], undefined).allowed).toBe(false);
  });

  it("空文字だけの環境変数から作った allowlist でも通さない", () => {
    expect(gateEmail(parseAllowedEmails(""), "owner@example.com").allowed).toBe(
      false,
    );
  });
});

describe("gateEmail", () => {
  it("一致すれば通す", () => {
    expect(gateEmail(ALLOWED, "owner@example.com")).toEqual({
      allowed: true,
    });
  });

  it("大文字と前後の空白は正規化して通す", () => {
    expect(gateEmail(ALLOWED, "  Owner@Example.COM  ").allowed).toBe(true);
  });

  it("一覧に無いメールは通さない", () => {
    expect(gateEmail(ALLOWED, "someone@example.com")).toEqual({
      allowed: false,
      reason: "このメールアドレスは許可されていません",
    });
  });

  it("メールが無ければ通さない", () => {
    expect(gateEmail(ALLOWED, undefined).allowed).toBe(false);
    expect(gateEmail(ALLOWED, "").allowed).toBe(false);
    expect(gateEmail(ALLOWED, "   ").allowed).toBe(false);
  });

  /*
    **部分一致で通さない。** `includes` を文字列に対して使う実装だと
    `evil-owner@example.com.attacker.example` が通ってしまう。
  */
  it("部分一致では通さない", () => {
    expect(gateEmail(ALLOWED, "evil-owner@example.com").allowed).toBe(false);
    expect(
      gateEmail(ALLOWED, "owner@example.com.attacker.example").allowed,
    ).toBe(false);
  });
});
