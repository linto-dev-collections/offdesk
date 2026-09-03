import { describe, expect, it } from "vitest";
import { safeRedirectPath } from "./redirect.ts";

/*
  オープンリダイレクト（plans/security.md 脅威 10）。

  ログイン後の戻り先は `/login?redirect=...` で外から与えられるので、
  **通すものを列挙する側**で書く。落とすものを列挙する形にすると、
  ブラウザの解釈の癖（`/\` を `//` と同じに読む等）を数え落とす。
*/

describe("safeRedirectPath — 通すもの", () => {
  it("`/` で始まる自サイト内のパス", () => {
    expect(safeRedirectPath("/")).toBe("/");
    expect(safeRedirectPath("/runs")).toBe("/runs");
    expect(safeRedirectPath("/runs?page=2")).toBe("/runs?page=2");
    expect(safeRedirectPath("/runs/OFFDESK-0123456789abcdef")).toBe(
      "/runs/OFFDESK-0123456789abcdef",
    );
  });

  it("前後の空白は落として通す", () => {
    expect(safeRedirectPath("  /runs  ")).toBe("/runs");
  });

  it("フラグメント付きも通す", () => {
    expect(safeRedirectPath("/p/plan#section")).toBe("/p/plan#section");
  });
});

describe("safeRedirectPath — 落とすもの", () => {
  it("未設定なら `/`", () => {
    expect(safeRedirectPath(undefined)).toBe("/");
    expect(safeRedirectPath("")).toBe("/");
    expect(safeRedirectPath("   ")).toBe("/");
  });

  /*
    **`//` はプロトコル相対 URL。** ブラウザは別ホストとして解決するので、
    「`/` で始まるから安全」という判定だけでは外部サイトへ飛ばせる。
  */
  it("プロトコル相対 URL", () => {
    expect(safeRedirectPath("//evil.example.com")).toBe("/");
    expect(safeRedirectPath("//evil.example.com/path")).toBe("/");
    expect(safeRedirectPath("  //evil.example.com")).toBe("/");
  });

  /** ブラウザが `/\` を `//` と同じに解釈することがある。 */
  it("バックスラッシュ始まり", () => {
    expect(safeRedirectPath("/\\evil.example.com")).toBe("/");
  });

  it("絶対 URL", () => {
    expect(safeRedirectPath("https://evil.example.com")).toBe("/");
    expect(safeRedirectPath("http://evil.example.com")).toBe("/");
  });

  it("スキーム付き", () => {
    expect(safeRedirectPath("javascript:alert(1)")).toBe("/");
    expect(safeRedirectPath("data:text/html,<script>")).toBe("/");
  });

  it("相対パス（現在地に依存して意図しない先へ行く）", () => {
    expect(safeRedirectPath("runs")).toBe("/");
    expect(safeRedirectPath("../admin")).toBe("/");
  });

  /*
    **制御文字を挟んで検査をすり抜ける形。** `/` で始まっているので前の 3 つの
    検査は通るが、ブラウザは制御文字を無視して解釈しうる。
  */
  it("制御文字を含むもの", () => {
    expect(safeRedirectPath("/\njavascript:alert(1)")).toBe("/");
    expect(safeRedirectPath("/\tevil")).toBe("/");
    expect(safeRedirectPath("/\u0000evil")).toBe("/");
    expect(safeRedirectPath("/\u007fevil")).toBe("/");
  });
});
