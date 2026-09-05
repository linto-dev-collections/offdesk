import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeGatewayFatal, resetGatewayDO } from "../support/gateway.ts";
import {
  jsonResponse,
  type OutboundStub,
  stubOutbound,
} from "../support/outbound.ts";
import { runCron } from "./support.ts";

/*
  Gateway の DO を起こす watchdog（要件 `F-I2`・`F-I4`・計画 P8 §3-3・§5）。

  **DO は自分では起動できない。** alarm ごと evict された状態から戻す手が
  これしかない。

  **ソケットを張るテストは書かない**（計画 P4 §5）。替え玉は握手を成立させない
  応答を返すので、DO は `backoff` に落ちる —— identify も送られないので
  bot token はどこへも出ない。**替え玉を置かないと本物の Gateway へ繋ぎに行く。**
*/

let stub: OutboundStub;

beforeEach(async () => {
  /*
    **DO を空へ戻す。** ストレージの分離はファイル単位なので、戻さないと
    「前のテストで `fatal` になった状態」から始まる（`fatal` は永続する）。
  */
  await resetGatewayDO();
  stub = stubOutbound([
    ["gateway.discord.gg", () => jsonResponse({ message: "no upgrade" }, 500)],
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const connects = (): number => stub.callsTo("gateway.discord.gg").length;

describe("idle なら繋ぎに行く", () => {
  it("Gateway へ接続を試みる", async () => {
    await runCron();

    expect(connects()).toBeGreaterThan(0);
  });

  /** **`wss://` を渡さない**（`fetch` に渡すと即座に落ちる。計画 P4 §3-3）。 */
  it("https:// で、版とエンコーディングが付いている", async () => {
    await runCron();

    const [connect] = stub.callsTo("gateway.discord.gg");
    expect(connect?.url).toMatch(/^https:\/\//);
    expect(connect?.url).toContain("v=10");
    expect(connect?.headers.upgrade).toBe("websocket");
  });
});

describe("張り直してよい状態でなければ何もしない", () => {
  /*
    **backoff の期限内は張らない。** 1 回目の cron で握手が成立せず backoff に
    落ちるので、続けて 2 回目を叩いても接続は増えない —— ここが増えると
    5 分ごとに identify を無駄に消費する（脅威 15）。
  */
  it("backoff の期限内なら 2 回目は繋ぎに行かない", async () => {
    await runCron();
    const before = connects();

    await runCron();

    expect(connects()).toBe(before);
  });
});

describe("fatal なら何もしない（要件 F-I4）", () => {
  /*
    **これが cron のいちばん危ない失敗。** `fatal`（close 4004 / 4014）は
    設定が違うので何回繋いでも同じところで切られる —— 5 分ごとに張り直すと
    **identify のレート制限（1 日 1000 回）を静かに使い切る**（脅威 15）。

    `env` の `DISCORD_BOT_TOKEN` を空にしても `fatal` は作れない（実測）——
    **DO は自分のバインディングの `env` を読む**ので、`scheduled` に渡した
    env は届かない。storage に置いて evict する（`makeGatewayFatal`）。
  */
  it("繋ぎに行かない", async () => {
    await makeGatewayFatal("close_4014");

    await runCron();

    expect(connects()).toBe(0);
  });

  it("何回叩いても繋ぎに行かない", async () => {
    await makeGatewayFatal("close_4004");

    await runCron();
    await runCron();
    await runCron();

    expect(connects()).toBe(0);
  });

  /** **人が直すまで戻らない状態なので `error` で声を上げる**（要件 `N-7`）。 */
  it("fatal を error でログに残す", async () => {
    await makeGatewayFatal("close_4014");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runCron();

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("fatal"),
      expect.objectContaining({ reason: "close_4014" }),
    );
    spy.mockRestore();
  });

  /** **理由は鍵だけ**（`close_4014` の形）。bot token に到達する値は出さない。 */
  it("ログに出るのは理由の鍵だけ", async () => {
    await makeGatewayFatal("close_4014");
    const lines: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        lines.push(JSON.stringify(args));
      });

    await runCron();

    expect(lines.join("\n")).toContain("close_4014");
    expect(lines.join("\n")).not.toContain("test-discord-bot-token");
    spy.mockRestore();
  });

  /** **ログに bot token を出さない**（脅威 12・15）。出すのは鍵だけ。 */
  it("ログに token を出さない", async () => {
    const lines: string[] = [];
    const error = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        lines.push(JSON.stringify(args));
      });
    const warn = vi
      .spyOn(console, "warn")
      .mockImplementation((...args: unknown[]) => {
        lines.push(JSON.stringify(args));
      });

    await runCron();

    expect(lines.join("\n")).not.toContain("test-discord-bot-token");
    error.mockRestore();
    warn.mockRestore();
  });
});
