import { describe, expect, it } from "vitest";
import { buildFireText } from "./prompt.ts";
import { NO_TARGET, type RunTarget } from "./target.ts";

const RUN_KEY = "OFFDESK-9f3a1c2b4d5e6f70";
const PROMPT = "READMEのtypoを直す";
const REPO = "https://github.com/acme/webapp";

const ISSUE: RunTarget = { kind: "issue", number: 123 };
const PULL: RunTarget = { kind: "pull", number: 45 };

const fireText = (target: RunTarget, repoUrl = REPO): string =>
  buildFireText(RUN_KEY, PROMPT, target, repoUrl);

describe("buildFireText", () => {
  it.each([ISSUE, PULL, NO_TARGET])("%o でも 1 行目が run_key", (target) => {
    expect(fireText(target).split("\n")[0]).toBe(RUN_KEY);
  });

  /** **作業対象が先、指示が後。** 依頼者の文が規則より前に来ると読み落とす。 */
  it.each([ISSUE, PULL, NO_TARGET])("%o で作業対象が指示より前", (target) => {
    const text = fireText(target);

    expect(text.indexOf("## 作業対象")).toBeLessThan(text.indexOf("## 指示"));
    expect(text.endsWith(PROMPT)).toBe(true);
  });

  it("Issue ではブランチと Closes を指定する", () => {
    const text = fireText(ISSUE);

    expect(text).toContain("gh issue view 123");
    expect(text).toContain("`claude/issue-123`");
    expect(text).toContain("Closes #123");
  });

  /*
    **PR のレビューはブランチも PR も作らない。** ここが抜けると、
    レビューのつもりの run が空のブランチと 2 本目の PR を残す。
  */
  it("PR ではブランチを作るなと言う", () => {
    const text = fireText(PULL);

    expect(text).toContain("gh pr diff 45");
    expect(text).toContain("**ブランチを作らないでください。**");
    expect(text).not.toContain("claude/");
  });

  /** 指定が無い run は、**GitHub の側から run を引ける印**を後置させる。 */
  it("指定なしでは run_key の後ろ 8 桁を後置させる", () => {
    const text = fireText(NO_TARGET);

    expect(text).toContain("claude/<内容が分かる短い名前>-4d5e6f70");
  });
});

/*
  **どの routine がどのリポジトリを clone するかは、offdesk からは読めない**
  （`/v1/claude_code/` の公開 API は `fire` の 1 本だけ）。

  `projects` 行は `repo_url` と `fire_url` を別々に持つので、設定を貼り間違えると
  「Discord ではプロジェクト A・`fire_url` は B の routine・Claude は B を変更」が
  成立する。**台帳側では検査できないので、突き合わせはセッションにやらせる。**
*/
describe("作業リポジトリの突き合わせ", () => {
  it.each([ISSUE, PULL, NO_TARGET])(
    "%o でも期待する repo を載せる",
    (target) => {
      expect(fireText(target)).toContain(REPO);
    },
  );

  /** **作業対象より前。** 規則を読む前に繋ぎ先を確かめさせる。 */
  it.each([ISSUE, PULL, NO_TARGET])("%o で作業対象より前に出す", (target) => {
    const text = fireText(target);

    expect(text.indexOf("## 作業リポジトリ")).toBeLessThan(
      text.indexOf("## 作業対象"),
    );
  });

  it("確かめ方（git remote get-url origin）を書く", () => {
    expect(fireText(NO_TARGET)).toContain("git remote get-url origin");
  });

  /*
    **食い違ったときに黙って正しそうな方を選ばせない。**
    間違ったリポジトリへの push は取り消せない。
  */
  it("見つからなければ変更せずに blocked で戻れと言う", () => {
    const text = fireText(NO_TARGET);

    expect(text).toContain("ファイルを 1 つも変更せずに");
    expect(text).toContain("`blocked`");
    expect(text).toContain("勝手に別のリポジトリで作業しないでください");
  });

  /** **複数 repo の routine を誤検知にしない**（cwd がたまたま別なことがある）。 */
  it("複数のリポジトリを clone している可能性に触れる", () => {
    expect(fireText(NO_TARGET)).toContain("複数のリポジトリ");
  });
});
