import { describe, expect, it } from "vitest";
import { buildFireText } from "./prompt.ts";
import { NO_TARGET, type RunTarget } from "./target.ts";

const RUN_KEY = "OFFDESK-9f3a1c2b4d5e6f70";
const PROMPT = "READMEのtypoを直す";

const ISSUE: RunTarget = { kind: "issue", number: 123 };
const PULL: RunTarget = { kind: "pull", number: 45 };

describe("buildFireText", () => {
  it.each([ISSUE, PULL, NO_TARGET])("%o でも 1 行目が run_key", (target) => {
    expect(buildFireText(RUN_KEY, PROMPT, target).split("\n")[0]).toBe(RUN_KEY);
  });

  /** **作業対象が先、指示が後。** 依頼者の文が規則より前に来ると読み落とす。 */
  it.each([ISSUE, PULL, NO_TARGET])("%o で作業対象が指示より前", (target) => {
    const text = buildFireText(RUN_KEY, PROMPT, target);

    expect(text.indexOf("## 作業対象")).toBeLessThan(text.indexOf("## 指示"));
    expect(text.endsWith(PROMPT)).toBe(true);
  });

  it("Issue ではブランチと Closes を指定する", () => {
    const text = buildFireText(RUN_KEY, PROMPT, ISSUE);

    expect(text).toContain("gh issue view 123");
    expect(text).toContain("`claude/issue-123`");
    expect(text).toContain("Closes #123");
  });

  /*
    **PR のレビューはブランチも PR も作らない。** ここが抜けると、
    レビューのつもりの run が空のブランチと 2 本目の PR を残す。
  */
  it("PR ではブランチを作るなと言う", () => {
    const text = buildFireText(RUN_KEY, PROMPT, PULL);

    expect(text).toContain("gh pr diff 45");
    expect(text).toContain("**ブランチを作らないでください。**");
    expect(text).not.toContain("claude/");
  });

  /** 指定が無い run は、**GitHub の側から run を引ける印**を後置させる。 */
  it("指定なしでは run_key の後ろ 8 桁を後置させる", () => {
    const text = buildFireText(RUN_KEY, PROMPT, NO_TARGET);

    expect(text).toContain("claude/<内容が分かる短い名前>-4d5e6f70");
  });
});
