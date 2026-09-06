import { describe, expect, it } from "vitest";
import { threadName } from "./discord/limits.ts";
import {
  branchFor,
  branchSuffix,
  isRunTargetProblem,
  NO_TARGET,
  parseRunTarget,
  parseThreadPrefix,
  type RunTarget,
  targetLabel,
  targetUrl,
  threadPrefix,
} from "./target.ts";

const ISSUE: RunTarget = { kind: "issue", number: 123 };
const PULL: RunTarget = { kind: "pull", number: 45 };

describe("parseRunTarget", () => {
  it("issue だけなら Issue の run", () => {
    expect(parseRunTarget({ issue: 123 })).toEqual(ISSUE);
  });

  it("pr だけなら PR の run", () => {
    expect(parseRunTarget({ pr: 45 })).toEqual(PULL);
  });

  it("どちらも無ければ対象なし", () => {
    expect(parseRunTarget({})).toEqual(NO_TARGET);
  });

  it("両方あると断る", () => {
    const resolved = parseRunTarget({ issue: 123, pr: 45 });

    expect(isRunTargetProblem(resolved)).toBe(true);
    expect(isRunTargetProblem(resolved) ? resolved.problem : "").toContain(
      "どちらか 1 つ",
    );
  });

  it.each([0, -1, 1.5, "12a", ""])("%s のような値は断る", (value) => {
    expect(isRunTargetProblem(parseRunTarget({ issue: value }))).toBe(true);
    expect(isRunTargetProblem(parseRunTarget({ pr: value }))).toBe(true);
  });

  /** Discord は数値で寄越すが、**別経路（テスト・REST）は文字列も寄越す。** */
  it("文字列の数字は受ける", () => {
    expect(parseRunTarget({ issue: "123" })).toEqual(ISSUE);
  });
});

describe("branchFor", () => {
  it("Issue のときだけブランチ名が決まる", () => {
    expect(branchFor(ISSUE)).toBe("claude/issue-123");
  });

  /** PR の run はブランチを作らない（レビューは PR にコメントするだけ）。 */
  it("PR と 指定なしは null", () => {
    expect(branchFor(PULL)).toBeNull();
    expect(branchFor(NO_TARGET)).toBeNull();
  });
});

/** **`claude/` 以外は push が弾かれうる**（保護ブランチ・他人の PR・他人のコミット）。 */
it("ブランチ名が claude/ で始まる", () => {
  expect(branchFor(ISSUE)?.startsWith("claude/")).toBe(true);
});

it("後置する印が run_key の後ろ 8 桁", () => {
  expect(branchSuffix("OFFDESK-9f3a1c2b4d5e6f70")).toBe("4d5e6f70");
});

describe("スレッド名", () => {
  it.each([
    [ISSUE, "OFFDESK #123"],
    [PULL, "OFFDESK PR#45"],
    [NO_TARGET, "OFFDESK"],
  ])("%o の前置きが %s", (target, expected) => {
    expect(threadPrefix(target)).toBe(expected);
  });

  /*
    **起こし直しはここだけを頼りに対象を拾う**（台帳に列が無い）。
    立てた名前から必ず読み戻せることを、実際に立てる関数を通して確かめる。
  */
  it.each([ISSUE, PULL, NO_TARGET])(
    "%o は立てた名前から読み戻せる",
    (target) => {
      const name = threadName(threadPrefix(target), "READMEのtypoを直す");

      expect(parseThreadPrefix(name)).toEqual(target);
    },
  );

  it("PR と Issue を取り違えない", () => {
    expect(parseThreadPrefix("OFFDESK PR#45 直す")).toEqual(PULL);
    expect(parseThreadPrefix("OFFDESK #45 直す")).toEqual({
      kind: "issue",
      number: 45,
    });
  });

  /** 人が改名したら対象なしに落ちる（別ブランチを勝手に作るより静か）。 */
  it.each(["雑談", "OFFDESK#123 直す", "OFFDESK #0 直す", ""])(
    "%s は対象なし",
    (name) => {
      expect(parseThreadPrefix(name)).toEqual(NO_TARGET);
    },
  );
});

describe("targetUrl", () => {
  const REPO = "https://github.com/linto-dev-collections/offdesk";

  it("Issue は /issues/、PR は /pull/", () => {
    expect(targetUrl(ISSUE, REPO)).toBe(`${REPO}/issues/123`);
    expect(targetUrl(PULL, REPO)).toBe(`${REPO}/pull/45`);
  });

  /** `repo_url` は `.git` 付きでも末尾 `/` 付きでも台帳に入りうる。 */
  it.each([`${REPO}.git`, `${REPO}/`, `${REPO}.git/`])(
    "%s から同じ URL を組む",
    (repoUrl) => {
      expect(targetUrl(ISSUE, repoUrl)).toBe(`${REPO}/issues/123`);
    },
  );

  it("対象なしは null", () => {
    expect(targetUrl(NO_TARGET, REPO)).toBeNull();
    expect(targetLabel(NO_TARGET)).toBeNull();
  });
});
