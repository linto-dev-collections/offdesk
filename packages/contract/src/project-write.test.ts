import { describe, expect, it } from "vitest";
import {
  ProjectCreateInput,
  ProjectDisableInput,
  ProjectUpdateInput,
} from "./project-write.ts";

/*
  投入の入口（plans/security.md 脅威 3 の 2 層目）。

  **このスキーマが唯一の門になった**（2026-09-16）。CLI が送る前に通していた頃は
  「CLI が拒否する」と「ここが落とす」が同義だったが、CLI ごと畳んだので
  **通るのは oRPC の入力検証だけ** —— 画面はここを抜けた値しか送れない。

  **重複（要件 `F-H4`）の検査はここに無い。** 1 件ずつ作る形になったので、
  ぶつかる相手は「いま入力した配列の中」ではなく**台帳の既存の行**
  （`rpc/projects.test.ts` の `CONFLICT`）。
*/

const created = (overrides: Record<string, unknown> = {}) => ({
  name: "offdesk-test",
  discordChannelId: "111111111111111111",
  repoUrl: "https://github.com/linto-dev-collections/offdesk-test",
  fireUrl: "https://api.anthropic.com/v1/claude_code/routines/trig_abc/fire",
  fireToken: "sk-ant-oat01-abcdefgh",
  ...overrides,
});

const parse = (entry: Record<string, unknown>) =>
  ProjectCreateInput.safeParse(entry);

describe("正しい形", () => {
  it("通る", () => {
    expect(parse(created()).success).toBe(true);
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
    expect(parse(created({ fireUrl })).success).toBe(false);
  });

  /** **直すときも同じ門を通る**（欄が別でも規則を分けない）。 */
  it.each([
    ["別ホスト", "https://evil.example.com/v1/fire"],
    ["サブドメイン", "https://evil.api.anthropic.com/v1/fire"],
  ])("update でも %s は落ちる", (_label, fireUrl) => {
    expect(
      ProjectUpdateInput.safeParse({
        id: "ckabc",
        discordChannelId: "111111111111111111",
        repoUrl: "https://github.com/x/y",
        fireUrl,
      }).success,
    ).toBe(false);
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
    expect(parse(created({ name })).success).toBe(false);
  });

  it.each(["offdesk", "offdesk-test", "off_desk_1", "a", "0abc"])(
    "%s は通る",
    (name) => {
      expect(parse(created({ name })).success).toBe(true);
    },
  );

  /*
    **直すときに名前は渡せない**（OPERATIONS §2 の「名前は変えない」）。

    名前が一致の鍵なので、変えると別のプロジェクトが増えて古い行が残る。
    **型として欄が無い**ので、画面にうっかり足しても値は届かない。
  */
  it("ProjectUpdateInput に name の欄が無い", () => {
    const result = ProjectUpdateInput.safeParse({
      id: "ckabc",
      name: "renamed",
      discordChannelId: "111111111111111111",
      repoUrl: "https://github.com/x/y",
      fireUrl: "https://api.anthropic.com/v1/claude_code/routines/t/fire",
    });

    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty("name");
  });
});

describe("discordChannelId", () => {
  it.each([
    ["数字でない", "11111111111111x"],
    ["14 桁", "11111111111111"],
    ["25 桁", "1".repeat(25)],
    ["空", ""],
    ["前に空白", " 111111111111111111"],
  ])("%s は落ちる", (_label, discordChannelId) => {
    expect(parse(created({ discordChannelId })).success).toBe(false);
  });
});

describe("その他の形", () => {
  it.each([
    ["repoUrl が http", { repoUrl: "http://github.com/x/y" }],
    ["fireToken が短い", { fireToken: "short" }],
    ["fireToken が無い", { fireToken: undefined }],
  ])("%s は落ちる", (_label, overrides) => {
    expect(parse(created(overrides)).success).toBe(false);
  });
});

describe("直すときの fireToken（省略できる）", () => {
  const update = (overrides: Record<string, unknown> = {}) => ({
    id: "ckabc",
    discordChannelId: "111111111111111111",
    repoUrl: "https://github.com/x/y",
    fireUrl: "https://api.anthropic.com/v1/claude_code/routines/t/fire",
    ...overrides,
  });

  /*
    **必須にできない。** claude.ai のトークンは発行時に 1 度しか表示されず、
    再発行すると前のトークンが失効する —— 必須にすると
    **チャンネルを変えるだけでローテーションを強制する**ことになる。
  */
  it("省略しても通る（据え置き）", () => {
    const result = ProjectUpdateInput.safeParse(update());

    expect(result.success).toBe(true);
    expect(result.data?.fireToken).toBeUndefined();
  });

  it("入れたら差し替え", () => {
    const result = ProjectUpdateInput.safeParse(
      update({ fireToken: "sk-ant-oat01-abcdefgh" }),
    );

    expect(result.success).toBe(true);
    expect(result.data?.fireToken).toBe("sk-ant-oat01-abcdefgh");
  });

  /** **省略できても、入れたなら同じ長さを要求する。** 空文字で消せない。 */
  it.each([
    ["空文字", ""],
    ["短い", "short"],
  ])("%s は落ちる", (_label, fireToken) => {
    expect(ProjectUpdateInput.safeParse(update({ fireToken })).success).toBe(
      false,
    );
  });
});

describe("止める・戻す（要件 F-H5）", () => {
  it.each([true, false])("disabled が %s なら通る", (disabled) => {
    expect(
      ProjectDisableInput.safeParse({ id: "ckabc", disabled }).success,
    ).toBe(true);
  });

  it.each([
    ["文字列", "true"],
    ["数値", 1],
    ["無い", undefined],
  ])("disabled が %s なら落ちる", (_label, disabled) => {
    expect(
      ProjectDisableInput.safeParse({ id: "ckabc", disabled }).success,
    ).toBe(false);
  });
});

describe("失敗のメッセージ", () => {
  /*
    plans/security.md 脅威 12。**値そのものをメッセージに載せない。**
    載せると fire トークンがブラウザの開発者ツールと Cloudflare のログに出る。
  */
  it("fireToken の値がメッセージに現れない", () => {
    const secret = "sk-ant-oat01-do-not-print-this";
    const result = parse(
      created({ fireToken: secret, fireUrl: "https://evil.example.com/fire" }),
    );

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).not.toContain(secret);
  });
});
