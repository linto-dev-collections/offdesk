import { describe, expect, it } from "vitest";
import { projectNames, resolveProject } from "./project.ts";

/*
  **プロジェクトを 2 つ以上用意する**（要件 N-9）。1 つだと「唯一だから選ばれた」に
  守られて、チャンネルとの紐付けが壊れていても気付けない。
*/
const ALPHA = { name: "offdesk-test", discordChannelId: "111111111111111111" };
const BETA = { name: "dummy", discordChannelId: "222222222222222222" };
const PROJECTS = [ALPHA, BETA] as const;

describe("resolveProject — 1 段目（名前の明示）", () => {
  it("名前が一致すればそれ", () => {
    expect(resolveProject(PROJECTS, { name: "dummy" })).toEqual({
      kind: "resolved",
      project: BETA,
    });
  });

  it("名前の明示はチャンネルの紐付けより強い", () => {
    const resolution = resolveProject(PROJECTS, {
      name: "dummy",
      channelId: ALPHA.discordChannelId,
    });

    expect(resolution).toEqual({ kind: "resolved", project: BETA });
  });

  /*
    **知らない名前は「無い」と言う。** チャンネルの紐付けに落とさない —— 打ち間違いが
    別のリポジトリへの起動になる。
  */
  it("知らない名前はチャンネルに落とさず unknown-name", () => {
    const resolution = resolveProject(PROJECTS, {
      name: "typo",
      channelId: ALPHA.discordChannelId,
    });

    expect(resolution).toEqual({ kind: "unknown-name", requested: "typo" });
  });

  it("空文字と空白は「明示なし」として扱う", () => {
    for (const name of ["", "   "]) {
      expect(
        resolveProject(PROJECTS, {
          name,
          channelId: ALPHA.discordChannelId,
        }),
      ).toEqual({ kind: "resolved", project: ALPHA });
    }
  });
});

describe("resolveProject — 2 段目（チャンネルの紐付け）", () => {
  it("チャンネルに紐付けばそれ", () => {
    expect(
      resolveProject(PROJECTS, { channelId: BETA.discordChannelId }),
    ).toEqual({ kind: "resolved", project: BETA });
  });

  it("スレッドの中なら parentId で照合する（要件 F-A3）", () => {
    const resolution = resolveProject(PROJECTS, {
      channelId: "999999999999999999",
      parentId: ALPHA.discordChannelId,
    });

    expect(resolution).toEqual({ kind: "resolved", project: ALPHA });
  });

  it("parentId を先に見る（スレッド id が別のプロジェクトに当たっても親が勝つ）", () => {
    const resolution = resolveProject(PROJECTS, {
      channelId: BETA.discordChannelId,
      parentId: ALPHA.discordChannelId,
    });

    expect(resolution).toEqual({ kind: "resolved", project: ALPHA });
  });
});

describe("resolveProject — 3 段目（黙って選ばない）", () => {
  /*
    要件 F-A2・計画 P2 §3-2。**「1 つしかないからそれ」に倒さない。**
    このテストが落ちるとき、雑談チャンネルの `/offdesk` が本番リポジトリに飛ぶ。
  */
  it("どこにも紐付いていなければ選ばない", () => {
    expect(
      resolveProject(PROJECTS, { channelId: "999999999999999999" }),
    ).toEqual({ kind: "no-binding" });
  });

  it("プロジェクトが 1 つだけでも選ばない", () => {
    expect(
      resolveProject([ALPHA], { channelId: "999999999999999999" }),
    ).toEqual({ kind: "no-binding" });
  });

  it("プロジェクトが 0 件でも選ばない", () => {
    expect(resolveProject([], { channelId: ALPHA.discordChannelId })).toEqual({
      kind: "no-binding",
    });
  });

  it("チャンネルが分からなくても選ばない", () => {
    expect(resolveProject(PROJECTS, {})).toEqual({ kind: "no-binding" });
  });
});

describe("projectNames", () => {
  it("案内文に出す一覧を作る", () => {
    expect(projectNames(PROJECTS)).toBe("offdesk-test / dummy");
  });
});
