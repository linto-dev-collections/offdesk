import { describe, expect, it } from "vitest";
import { GATEWAY_URL, gatewayConnectUrl } from "./gateway.ts";

/*
  **`fetch` に `wss://` を渡すと `Fetch API cannot load: wss://…` で即座に落ちる**
  （計画 P4 §3-3・§7）。ソケットが開かないので「原因不明で繋がらない」にしか
  見えず、いちばん時間を取られる形。だから直す場所を 1 か所に閉じて固める。

  **`new URL` で組み立てない**（`packages/domain` は `types: []` で閉じてある）。
  手で切っているぶん、境界の形をここで全部踏んでおく。
*/

describe("gatewayConnectUrl", () => {
  it("wss:// を https:// に直す", () => {
    expect(gatewayConnectUrl("wss://gateway.discord.gg/")).toMatch(
      /^https:\/\//,
    );
  });

  it("ws:// を http:// に直す", () => {
    expect(gatewayConnectUrl("ws://localhost:9999/")).toMatch(/^http:\/\//);
  });

  it("既定の宛先は wss:// で書いてある（直す前の形を持っている）", () => {
    expect(GATEWAY_URL).toMatch(/^wss:\/\//);
    expect(gatewayConnectUrl(GATEWAY_URL)).not.toContain("wss://");
  });

  /*
    **`resume_gateway_url` はクエリを持たない形で来る。** 付け直さないと
    Discord 側の既定の版に繋がる（v6 は 2022 年に落ちている）。
  */
  it("版とエンコーディングを付ける", () => {
    expect(gatewayConnectUrl("wss://gateway-us-east1-b.discord.gg")).toBe(
      "https://gateway-us-east1-b.discord.gg/?v=10&encoding=json",
    );
  });

  it("パスを保つ", () => {
    expect(gatewayConnectUrl("wss://gateway.discord.gg/socket")).toBe(
      "https://gateway.discord.gg/socket?v=10&encoding=json",
    );
  });

  it("ポートを保つ", () => {
    expect(gatewayConnectUrl("ws://127.0.0.1:8787/")).toBe(
      "http://127.0.0.1:8787/?v=10&encoding=json",
    );
  });

  it("既にクエリが付いていても重ねない", () => {
    const url = gatewayConnectUrl("wss://gateway.discord.gg/?v=6&encoding=etf");

    expect(url).toContain("v=10");
    expect(url).not.toContain("v=6");
    expect(url).not.toContain("etf");
  });

  it("フラグメントを落とす", () => {
    expect(gatewayConnectUrl("wss://gateway.discord.gg/#x")).toBe(
      "https://gateway.discord.gg/?v=10&encoding=json",
    );
  });

  /*
    **壊れた値でも投げない。** ここで例外を出すと DO の遷移が止まって
    「evict されたまま戻らない」になる。既定の宛先に倒せば復帰できる。
  */
  it.each(["", "not a url", "://", "wss://", "ftp://x/", "//x/"])(
    "壊れた値（%s）は既定の宛先に倒す",
    (raw) => {
      expect(gatewayConnectUrl(raw)).toBe(gatewayConnectUrl(GATEWAY_URL));
    },
  );
});
