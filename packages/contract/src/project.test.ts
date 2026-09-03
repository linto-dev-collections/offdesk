import { describe, expect, it } from "vitest";
import { ProjectSyncInput } from "./project.ts";

/*
  投入の入口（plans/security.md 脅威 3 の 2 層目）。

  **この 1 つのスキーマが 2 か所の門になる** —— 投入 CLI（`packages/cli`）が送る前に、
  Worker の投入口が受け取ったあとに、同じものを通す。だから「CLI が拒否する」は
  ここが落とすことと同義で、CLI 側に別の検証を書かない。
*/

const entry = (overrides: Record<string, unknown> = {}) => ({
  name: "offdesk-test",
  discordChannelId: "111111111111111111",
  repoUrl: "https://github.com/linto-dev-collections/offdesk-test",
  fireUrl: "https://api.anthropic.com/v1/claude_code/routines/trig_abc/fire",
  fireToken: "sk-ant-oat01-abcdefgh",
  contextWindowTokens: 1_000_000,
  ...overrides,
});

const parse = (projects: readonly unknown[]) =>
  ProjectSyncInput.safeParse({ projects });

describe("正しい形", () => {
  it("通る", () => {
    expect(parse([entry()]).success).toBe(true);
  });

  it("2 件でも通る", () => {
    expect(
      parse([
        entry(),
        entry({ name: "dummy", discordChannelId: "222222222222222222" }),
      ]).success,
    ).toBe(true);
  });
});

describe("fireUrl（脅威 3）", () => {
  /*
    **`https://api.anthropic.com/` 以外を拒否する。** この URL は fire トークンを
    Authorization ヘッダに載せて POST する宛先なので、1 文字違いでも
    資格情報の持ち出しが成立する。
  */
  it.each([
    ["別ホスト", "https://evil.example.com/v1/fire"],
    ["1 文字違い", "https://api.anthropic.co/v1/fire"],
    ["部分文字列で騙す", "https://api.anthropic.com.evil.example/v1/fire"],
    ["サブドメイン", "https://evil.api.anthropic.com/v1/fire"],
    ["http", "http://api.anthropic.com/v1/fire"],
    ["利用者情報で騙す", "https://api.anthropic.com@evil.example/v1/fire"],
    ["前に空白", " https://api.anthropic.com/v1/fire"],
    ["スキーム無し", "api.anthropic.com/v1/fire"],
    ["空", ""],
  ])("%s は落ちる", (_label, fireUrl) => {
    expect(parse([entry({ fireUrl })]).success).toBe(false);
  });
});

describe("name（DDL の projects_name_shape_ck と同じ規則）", () => {
  it.each([
    ["大文字", "Offdesk"],
    ["空白入り", "off desk"],
    ["先頭が記号", "-offdesk"],
    ["先頭が _", "_offdesk"],
    ["記号入り", "off.desk"],
    ["日本語", "オフデスク"],
    ["空", ""],
    ["33 文字", "a".repeat(33)],
  ])("%s は落ちる", (_label, name) => {
    expect(parse([entry({ name })]).success).toBe(false);
  });

  it.each(["offdesk", "offdesk-test", "off_desk_1", "a", "0abc"])(
    "%s は通る",
    (name) => {
      expect(parse([entry({ name })]).success).toBe(true);
    },
  );
});

describe("discordChannelId", () => {
  it.each([
    ["数字でない", "11111111111111x"],
    ["14 桁", "11111111111111"],
    ["25 桁", "1".repeat(25)],
    ["空", ""],
    ["前に空白", " 111111111111111111"],
  ])("%s は落ちる", (_label, discordChannelId) => {
    expect(parse([entry({ discordChannelId })]).success).toBe(false);
  });
});

describe("その他の形", () => {
  it.each([
    ["repoUrl が http", { repoUrl: "http://github.com/x/y" }],
    ["fireToken が短い", { fireToken: "short" }],
    ["context が 0", { contextWindowTokens: 0 }],
    ["context が負", { contextWindowTokens: -1 }],
    ["context が小数", { contextWindowTokens: 1.5 }],
    ["context が文字列", { contextWindowTokens: "1000000" }],
  ])("%s は落ちる", (_label, overrides) => {
    expect(parse([entry(overrides)]).success).toBe(false);
  });

  it("空の配列は落ちる", () => {
    expect(parse([]).success).toBe(false);
  });
});

describe("重複（要件 F-H4）", () => {
  /*
    **D1 の UNIQUE でも止まるが、そちらは batch の途中で落ちる**ので
    「何件入ったか分からない」。送る前に落とす。
  */
  it("同じ name が 2 つあれば落ちる", () => {
    const result = parse([
      entry(),
      entry({ discordChannelId: "222222222222222222" }),
    ]);

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join("."))).toContain(
      "projects.1.name",
    );
  });

  it("同じ discordChannelId が 2 つあれば落ちる", () => {
    const result = parse([entry(), entry({ name: "dummy" })]);

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join("."))).toContain(
      "projects.1.discordChannelId",
    );
  });
});

describe("失敗のメッセージ", () => {
  /*
    plans/security.md 脅威 12。**値そのものをメッセージに載せない。**
    載せると fire トークンがターミナルと CI のログに出る。
  */
  it("fireToken の値がメッセージに現れない", () => {
    const secret = "sk-ant-oat01-do-not-print-this";
    const result = parse([
      entry({ fireToken: secret, fireUrl: "https://evil.example.com/fire" }),
    ]);

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).not.toContain(secret);
  });
});
