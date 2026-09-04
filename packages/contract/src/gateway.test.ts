import { describe, expect, it } from "vitest";
import { GATEWAY_STATES, GatewayStatus, gatewayFatalHint } from "./gateway.ts";

/*
  Gateway の状態と `fatal` の直し方（要件 `F-I7`・計画 P4 §3-7・P7b §3-3）。

  **文言をここに置いてある理由が要点。** `curl` で見る `hint` と画面の文が
  同じ関数を引くので、片方だけ直すことができない ——
  `fatal` は人が直すまで戻らない状態なので、**何をすれば戻るのかが
  出ていないと詰む。**
*/

describe("gatewayFatalHint", () => {
  it("fatal でなければ null（理由が無い）", () => {
    expect(gatewayFatalHint(null)).toBeNull();
  });

  it.each([
    ["no_token", /DISCORD_BOT_TOKEN/],
    ["close_4004", /Reset Token/],
    ["close_4014", /MESSAGE CONTENT INTENT/],
    ["close_4013", /GATEWAY_INTENTS/],
  ])("%s には直し方が出る", (reason, pattern) => {
    expect(gatewayFatalHint(reason)).toMatch(pattern);
  });

  /** **知らない理由でも黙らない。** 生の理由 ＋ 張り直しの案内に倒す。 */
  it("知らない理由には生の理由と案内が出る", () => {
    const hint = gatewayFatalHint("close_9999");

    expect(hint).toContain("close_9999");
    expect(hint).toMatch(/\/gateway\/reset/);
  });

  /*
    **bot token に到達する値を文言に混ぜない**（脅威 15）。
    「token を入れ直す」は書くが、値そのものを埋める余地は無い
    （引数は鍵の文字列 1 本だけ）。
  */
  it("文言に値を差し込む口が無い", () => {
    expect(gatewayFatalHint("close_4004")).not.toContain("Bearer");
  });
});

describe("GatewayStatus", () => {
  const base = {
    state: "live",
    healthy: true,
    fatalReason: null,
    lastEventAt: 1_757_000_000_000,
    connected: true,
    resetAvailableAt: null,
  };

  it("5 状態すべてを通す", () => {
    for (const state of GATEWAY_STATES) {
      expect(GatewayStatus.parse({ ...base, state }).state).toBe(state);
    }
  });

  it("知らない状態は通さない", () => {
    expect(() => GatewayStatus.parse({ ...base, state: "sleeping" })).toThrow();
  });

  /*
    **スキーマに無い値は落ちる**（`apps/app/src/worker/gateway/client.ts` の
    `parse` が 1 段目の守り）。DO 側にデバッグ情報を足したときに、
    bot token に到達する値が外へ出る経路をここが塞ぐ。
  */
  it("知らない鍵は応答に残らない", () => {
    const parsed = GatewayStatus.parse({ ...base, token: "secret" });

    expect(parsed).not.toHaveProperty("token");
  });

  it.each([
    "state",
    "healthy",
    "fatalReason",
    "lastEventAt",
    "connected",
    "resetAvailableAt",
  ])("%s が欠けたら通らない", (key) => {
    const without = Object.fromEntries(
      Object.entries(base).filter(([name]) => name !== key),
    );

    expect(() => GatewayStatus.parse(without)).toThrow();
  });
});
