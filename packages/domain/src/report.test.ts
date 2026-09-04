import { describe, expect, it } from "vitest";
import {
  isReportProblem,
  isStateChange,
  MAX_REPORT_BODY_LENGTH,
  REPORT_KINDS,
  validateReport,
} from "./report.ts";

const ok = (kind: unknown, body: unknown) => {
  const result = validateReport({ kind, body });
  if (isReportProblem(result))
    throw new Error(`通ると思ったのに: ${result.problem}`);
  return result;
};

const problem = (kind: unknown, body: unknown): string => {
  const result = validateReport({ kind, body });
  if (!isReportProblem(result)) throw new Error("落ちると思ったのに通った");
  return result.problem;
};

describe("validateReport が通す形", () => {
  it.each([...REPORT_KINDS])("%s は通る", (kind) => {
    expect(ok(kind, "進めています").kind).toBe(kind);
  });

  it("本文の前後の空白を落とす", () => {
    expect(ok("progress", "  進めています  ").body).toBe("進めています");
  });

  it("上限ちょうどの本文は通る", () => {
    const body = "あ".repeat(MAX_REPORT_BODY_LENGTH);
    expect(ok("progress", body).body).toBe(body);
  });
});

describe("validateReport が落とす形", () => {
  /*
    **`events.kind` の 5 種のうち 3 種だけを口に出す。** `stop_hook`（P5）と
    `error`（P8）は offdesk 自身が書く種で、Claude に選ばせるものではない ——
    一覧を 1 つにまとめると、routine が `error` を書けるようになる。
  */
  it.each(["stop_hook", "error"])(
    "offdesk 自身が書く種（%s）は Claude から受け取らない",
    (kind) => {
      expect(problem(kind, "x")).toContain("kind は");
    },
  );

  it.each([
    ["知らない kind", "zombie"],
    ["大文字", "PROGRESS"],
    ["空文字", ""],
    ["数", 1],
    ["undefined", undefined],
  ])("%s は落とす", (_label, kind) => {
    expect(problem(kind, "x")).toContain("kind は");
  });

  it("body が空", () => {
    expect(problem("progress", "")).toContain("body が空");
    expect(problem("progress", "   ")).toContain("body が空");
    expect(problem("progress", undefined)).toContain("body が空");
    expect(problem("progress", 42)).toContain("body が空");
  });

  it("body が長すぎる（黙って切らない）", () => {
    const body = "あ".repeat(MAX_REPORT_BODY_LENGTH + 1);
    expect(problem("progress", body)).toContain("長すぎます");
  });
});

describe("isStateChange", () => {
  /*
    **枠を付けてよいのは状態が変わったときだけ**（要件 `F-B5`）。
    `progress` は Claude 本人の発言なので地の文。
  */
  it("progress は状態の変化ではない", () => {
    expect(isStateChange("progress")).toBe(false);
  });

  it.each(["done", "blocked"] as const)("%s は状態の変化", (kind) => {
    expect(isStateChange(kind)).toBe(true);
  });

  it("progress 以外は全部状態の変化として扱う", () => {
    // 種を足したときに「枠なし」が既定にならないこと（付け忘れより出しすぎの方が安い）。
    const changes = REPORT_KINDS.filter((kind) => isStateChange(kind));
    expect(changes).toEqual(REPORT_KINDS.filter((kind) => kind !== "progress"));
  });
});
