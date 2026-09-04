import { describe, expect, it } from "vitest";
import {
  entryPath,
  isMarkdownPath,
  isPlanSlug,
  MAX_PLAN_FILE_BYTES,
  MAX_PLAN_FILES,
  MAX_PLAN_TOTAL_BYTES,
  normalizePlanPath,
  planContentType,
} from "./plan-path.ts";

/*
  パス正規化（plans/security.md 脅威 8・計画 P6 §6）。

  **R2 のキーは `plans/<plan_id>/<ここ>`** なので、prefix の外へ出られないことが
  唯一の防御。ここが甘いと `../` で別の計画のファイルを読み書きできる。
*/

describe("通さないパス", () => {
  it.each([
    ["空", ""],
    ["遡上", "../../etc/passwd"],
    ["先頭が ..", "../a.md"],
    ["途中に ..", "a/../../b.md"],
    ["セグメントが .", "a/./b.md"],
    /*
      **符号化されたままでも落ちる**（自分で復号しないので `%` が集合の外）。
      実際には Hono が 1 回復号して渡すので、単純な符号化は `..` の
      セグメントとして落ちる —— **二重符号化だけがここまで `%` を持って
      届く**（3 層の実測は `apps/app/test/plans/upload.test.ts`）。
    */
    ["%2f で符号化した遡上", "..%2f..%2fetc"],
    ["二重に符号化", "..%252f..%252fetc"],
    ["先頭のスラッシュ", "/abs/path.md"],
    ["末尾のスラッシュ", "phase-01/"],
    ["連続スラッシュ", "a//b.md"],
    ["逆スラッシュ", "a\\b.md"],
    ["隠しファイル", ".env"],
    ["隠しディレクトリ", ".claude/settings.json"],
    ["空白", "a b.md"],
    ["日本語", "計画.md"],
    ["山括弧", "<script>.md"],
    ["コロン", "c:/a.md"],
    ["百分率", "a%20b.md"],
  ])("%s", (_label, raw) => {
    expect(normalizePlanPath(raw)).toBeNull();
  });

  /** 制御文字も集合の外（`PATH_CHARSET_RE` が落とす）。 */
  it.each([
    ["改行", "a\nb.md"],
    ["タブ", "a\tb.md"],
    ["NUL", "a\u0000b.md"],
  ])("%s", (_label, raw) => {
    expect(normalizePlanPath(raw)).toBeNull();
  });

  it("257 文字", () => {
    expect(normalizePlanPath(`${"a".repeat(254)}.md`)).toBeNull();
  });

  it("256 文字は通る（境界）", () => {
    const path = `${"a".repeat(253)}.md`;

    expect(path).toHaveLength(256);
    expect(normalizePlanPath(path)).toBe(path);
  });
});

describe("通すパス", () => {
  /*
    **`a..b.md` を落とさない。** 見ているのは「セグメントの先頭がドットか」なので、
    ドットが真ん中にあるファイル名は正当なものとして通る（計画 P6 §4-2）。
  */
  it.each([
    "README.md",
    "phase-01/detail.md",
    "a..b.md",
    "a.b.c.md",
    "docs/img/diagram.png",
    "UPPER_case-1.md",
  ])("%s", (raw) => {
    expect(normalizePlanPath(raw)).toBe(raw);
  });

  /** **書き換えない。** 正規化と言いつつ別のパスへ倒すと「置いたのに無い」になる。 */
  it("通ったものは 1 文字も変わらない", () => {
    const raw = "phase-01/detail.md";

    expect(normalizePlanPath(raw)).toBe(raw);
  });
});

describe("計画の名前（plans_slug_shape_ck と同じ形）", () => {
  it.each(["a", "github-link", "phase_06", "p6", "a".repeat(64)])(
    "%s は通る",
    (value) => {
      expect(isPlanSlug(value)).toBe(true);
    },
  );

  it.each([
    ["空", ""],
    ["大文字", "GitHub"],
    ["先頭がハイフン", "-a"],
    ["先頭がアンダースコア", "_a"],
    ["スラッシュ", "a/b"],
    ["ドット", "a.b"],
    ["空白", "a b"],
    ["65 文字", "a".repeat(65)],
  ])("%s は通らない", (_label, value) => {
    expect(isPlanSlug(value)).toBe(false);
  });
});

describe("content-type", () => {
  it.each([
    ["README.md", "text/markdown; charset=utf-8"],
    ["notes.txt", "text/plain; charset=utf-8"],
    ["shot.png", "image/png"],
    ["shot.jpg", "image/jpeg"],
    ["data.json", "application/json; charset=utf-8"],
    ["flow.mmd", "text/plain; charset=utf-8"],
  ])("%s → %s", (path, expected) => {
    expect(planContentType(path)).toBe(expected);
  });

  /*
    **`.svg` は `image/svg+xml` で返さない**（plans/security.md 脅威 7）。
    SVG は `<script>` を持てるので、自分のオリジンで任意のスクリプトが動く形になる。
  */
  it("svg は text/plain（image/svg+xml にしない）", () => {
    expect(planContentType("diagram.svg")).toBe("text/plain; charset=utf-8");
  });

  it.each(["a.html", "a.js", "a.jpeg", "a.gif", "a", "Makefile", "a.MD."])(
    "%s は null（呼ぶ側が 400 か attachment にする）",
    (path) => {
      expect(planContentType(path)).toBeNull();
    },
  );

  it("拡張子は大文字でも当たる", () => {
    expect(planContentType("README.MD")).toBe("text/markdown; charset=utf-8");
  });

  it.each([
    ["README.md", true],
    ["README.MD", true],
    ["a/b.md", true],
    ["a.mmd", false],
    ["md", false],
  ])("isMarkdownPath(%s) === %s", (path, expected) => {
    expect(isMarkdownPath(path)).toBe(expected);
  });
});

describe("入口の選び方", () => {
  it("README.md があればそれ", () => {
    expect(entryPath(["phase-01.md", "README.md", "img.png"])).toBe(
      "README.md",
    );
  });

  it("大文字小文字は問わない", () => {
    expect(entryPath(["phase-01.md", "readme.md"])).toBe("readme.md");
  });

  /** **根の README.md だけを見る。** 入れ子のものは入口にしない。 */
  it("docs/README.md は入口にしない", () => {
    expect(entryPath(["docs/README.md", "a-phase.md"])).toBe("a-phase.md");
  });

  it("無ければ最初の markdown（並べ替えた順）", () => {
    expect(entryPath(["z.md", "img.png", "b.md"])).toBe("b.md");
  });

  it("markdown が無ければ最初のファイル", () => {
    expect(entryPath(["z.png", "a.png"])).toBe("a.png");
  });

  it("何も無ければ null", () => {
    expect(entryPath([])).toBeNull();
  });

  /** **渡された配列を並べ替えない**（呼ぶ側は R2 の一覧をそのまま使う）。 */
  it("引数を破壊しない", () => {
    const paths = ["z.md", "a.md"];

    entryPath(paths);

    expect(paths).toEqual(["z.md", "a.md"]);
  });
});

describe("上限（脅威 9）", () => {
  it("値が計画のとおり", () => {
    expect(MAX_PLAN_FILE_BYTES).toBe(1024 * 1024);
    expect(MAX_PLAN_FILES).toBe(64);
    expect(MAX_PLAN_TOTAL_BYTES).toBe(8 * 1024 * 1024);
  });

  /** 実測の最大（1 計画 231,647 バイト / 7 ファイル）に桁 1 つ以上の余裕がある。 */
  it("実測の最大より十分に大きい", () => {
    expect(MAX_PLAN_TOTAL_BYTES).toBeGreaterThan(231_647 * 10);
    expect(MAX_PLAN_FILES).toBeGreaterThan(7 * 5);
  });
});
