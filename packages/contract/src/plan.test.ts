import { describe, expect, it } from "vitest";
import { PlanListOutput, PlanRemoveInput, PlanSummary } from "./plan.ts";

/*
  計画の DTO（計画 P7b §3-1）。

  **見ているのは「欠けたら落ちる」こと。** 一覧の 1 行はサーバーが組んで
  `.output()` で検証されるので、フィールドを足したのに埋め忘れると
  **「画面がおかしい」ではなく「その手続きが出力検証で落ちる」形**で出る。
*/

const summary = {
  planId: "a".repeat(32),
  scopeKind: "thread",
  scopeLabel: "444444444444444444",
  scopeUrl: "https://discord.com/channels/999/444444444444444444",
  slug: "phase-07b",
  fileCount: 3,
  totalBytes: 231_647,
  updatedAt: 1_757_000_000_000,
  viewUrl: `/p/${"a".repeat(32)}/`,
  lastPublishedRunKey: "OFFDESK-1111111111111111",
};

describe("PlanSummary", () => {
  it("そろっていれば通る", () => {
    expect(PlanSummary.parse(summary).slug).toBe("phase-07b");
  });

  it.each(Object.keys(summary))("%s が欠けたら通らない", (key) => {
    const without = Object.fromEntries(
      Object.entries(summary).filter(([name]) => name !== key),
    );

    expect(() => PlanSummary.parse(without)).toThrow();
  });

  /** `plans_scope_kind_ck` と同じ 2 値だけ（テーブル定義書 §4-7）。 */
  it.each(["thread", "run"])("scopeKind は %s を通す", (scopeKind) => {
    expect(PlanSummary.parse({ ...summary, scopeKind }).scopeKind).toBe(
      scopeKind,
    );
  });

  it("知らない scopeKind は通らない", () => {
    expect(() =>
      PlanSummary.parse({ ...summary, scopeKind: "channel" }),
    ).toThrow();
  });

  /*
    **`scopeUrl` は `null` になれる。** `DISCORD_GUILD_ID` が未設定なら
    リンクが組めない —— そこで落ちると、guild id を入れるまで
    計画一覧そのものが 500 になる。
  */
  it("scopeUrl は null を通す", () => {
    expect(
      PlanSummary.parse({ ...summary, scopeUrl: null }).scopeUrl,
    ).toBeNull();
  });

  /** 控えの 2 列は整数（`plans_counts_ck` と対）。 */
  it("fileCount に小数は通らない", () => {
    expect(() => PlanSummary.parse({ ...summary, fileCount: 1.5 })).toThrow();
  });
});

describe("PlanListOutput", () => {
  it("空の一覧を通す（まだ何も置かれていない）", () => {
    expect(PlanListOutput.parse({ items: [] }).items).toEqual([]);
  });

  it("1 行でも形が違えば落ちる", () => {
    expect(() =>
      PlanListOutput.parse({ items: [summary, { slug: "x" }] }),
    ).toThrow();
  });
});

describe("PlanRemoveInput", () => {
  it("32 桁の小文字 16 進を通す", () => {
    expect(PlanRemoveInput.parse({ planId: "a".repeat(32) }).planId).toBe(
      "a".repeat(32),
    );
  });

  /*
    **形をここで閉じる**（plans/security.md 脅威 8）。`plan_id` は R2 のキーの
    一部になるので、`../` を含む値が通ると接頭辞から出られる。
  */
  it.each([
    ["31 桁", "0".repeat(31)],
    ["33 桁", "0".repeat(33)],
    ["大文字", "A".repeat(32)],
    ["パス区切り", `../${"a".repeat(29)}`],
  ])("%s は通らない", (_label, planId) => {
    expect(() => PlanRemoveInput.parse({ planId })).toThrow();
  });
});
