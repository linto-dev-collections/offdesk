import { describe, expect, it } from "vitest";
import {
  answerCustomId,
  isAskProblem,
  MAX_ASK_OPTIONS,
  MAX_ASK_QUESTION_LENGTH,
  parseAnswerCustomId,
  validateAsk,
} from "./ask.ts";
import {
  DISCORD_BUTTON_LABEL_MAX,
  DISCORD_CUSTOM_ID_MAX,
} from "./discord/limits.ts";

const ASK_ID = "ask_0123456789abcdef";

const ok = (question: unknown, options: unknown) => {
  const result = validateAsk({ question, options });
  if (isAskProblem(result))
    throw new Error(`通ると思ったのに: ${result.problem}`);
  return result;
};

const problem = (question: unknown, options: unknown): string => {
  const result = validateAsk({ question, options });
  if (!isAskProblem(result)) throw new Error("落ちると思ったのに通った");
  return result.problem;
};

describe("validateAsk が通す形", () => {
  it("問いと選択肢の前後の空白を落とす", () => {
    expect(ok("  どちらにしますか  ", [" はい ", "いいえ"])).toEqual({
      question: "どちらにしますか",
      options: ["はい", "いいえ"],
    });
  });

  it("上限ちょうどの選択肢は通る", () => {
    const options = Array.from({ length: MAX_ASK_OPTIONS }, (_, i) => `o${i}`);
    expect(ok("q", options).options).toHaveLength(MAX_ASK_OPTIONS);
  });

  it("上限ちょうどの長さのラベルは通る", () => {
    const label = "あ".repeat(DISCORD_BUTTON_LABEL_MAX);
    expect(ok("q", [label]).options).toEqual([label]);
  });

  it("上限ちょうどの長さの問いは通る", () => {
    const question = "あ".repeat(MAX_ASK_QUESTION_LENGTH);
    expect(ok(question, ["はい"]).question).toBe(question);
  });
});

describe("validateAsk が落とす形", () => {
  /*
    **黙って切り捨てない**（計画 P3a §4）。上限を越えた入力は Claude へ返して
    直させる。勝手に削ると、Claude が想定した選択肢と人が押せる選択肢がズレる。
  */
  it("問いが空", () => {
    expect(problem("", ["はい"])).toContain("question が空");
    expect(problem("   ", ["はい"])).toContain("question が空");
    expect(problem(undefined, ["はい"])).toContain("question が空");
    expect(problem(42, ["はい"])).toContain("question が空");
  });

  it("問いが長すぎる", () => {
    const question = "あ".repeat(MAX_ASK_QUESTION_LENGTH + 1);
    expect(problem(question, ["はい"])).toContain("長すぎます");
  });

  /*
    **P3a では選択肢が必須**（2026-09-04 の決定）。答える口はボタンだけで、
    スレッドへ素で書いた文が届くのは P4。選択肢 0 個の問いは誰も答えられない。

    **P4 でスレッドの口が開いたら、この 2 つを「空でも通る」に反転させる。**
  */
  it("選択肢が空なら落とす（P3a の判断）", () => {
    expect(problem("q", [])).toContain("options が空");
    expect(problem("q", undefined)).toContain("options が空");
  });

  it("選択肢が全部空文字なら落とす", () => {
    expect(problem("q", ["  "])).toContain("options[0] が空");
  });

  it("選択肢が多すぎる", () => {
    const options = Array.from(
      { length: MAX_ASK_OPTIONS + 1 },
      (_, i) => `o${i}`,
    );
    expect(problem("q", options)).toContain("多すぎます");
  });

  it("選択肢のラベルが Discord の上限を超える", () => {
    const label = "あ".repeat(DISCORD_BUTTON_LABEL_MAX + 1);
    expect(problem("q", [label])).toContain("長すぎます");
  });

  it("選択肢が配列ではない", () => {
    expect(problem("q", "はい")).toContain("文字列の配列");
    expect(problem("q", { a: 1 })).toContain("文字列の配列");
  });

  it("選択肢の要素が文字列ではない", () => {
    expect(problem("q", ["はい", 2])).toContain(
      "options[1] が文字列ではありません",
    );
  });

  it("選択肢が重複している", () => {
    // 押されたときは index で区別できるが、人には同じボタンが 2 つ並んで見える。
    expect(problem("q", ["はい", " はい "])).toContain("同じ値");
  });
});

describe("custom_id", () => {
  it("往復する", () => {
    expect(parseAnswerCustomId(answerCustomId(ASK_ID, 3))).toEqual({
      askId: ASK_ID,
      index: 3,
    });
  });

  it("Discord の上限に収まる", () => {
    // ここが越えると Discord がメッセージそのものを拒否する（問いが出ない）。
    const longest = answerCustomId(ASK_ID, MAX_ASK_OPTIONS - 1);
    expect(longest.length).toBeLessThanOrEqual(DISCORD_CUSTOM_ID_MAX);
  });

  it.each([
    ["undefined", undefined],
    ["空文字", ""],
    ["別の接頭辞", `pick:${ASK_ID}:0`],
    ["区切りが足りない", `ans:${ASK_ID}`],
    ["区切りが多い", `ans:${ASK_ID}:0:0`],
    ["ask_id が空", "ans::0"],
    ["index が空", `ans:${ASK_ID}:`],
    ["index が数字でない", `ans:${ASK_ID}:x`],
    ["index が負", `ans:${ASK_ID}:-1`],
    ["index に空白", `ans:${ASK_ID}: 1`],
    ["index が上限以上", `ans:${ASK_ID}:${MAX_ASK_OPTIONS}`],
  ])("%s は拒否する", (_label, customId) => {
    expect(parseAnswerCustomId(customId)).toBeNull();
  });

  /*
    **`Number("")` は 0**。空文字を 0 番として通すと、押していないボタンの答えが
    入りうる形になる（上の「index が空」がその probe）。
  */
  it("index が空文字のとき 0 番として通らない", () => {
    expect(Number("")).toBe(0);
    expect(parseAnswerCustomId(`ans:${ASK_ID}:`)).toBeNull();
  });
});
