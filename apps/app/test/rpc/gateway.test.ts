import { env } from "cloudflare:workers";
import { GatewayStatus } from "@offdesk/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signIn } from "../auth/support.ts";
import { resetGatewayDO } from "../support/gateway.ts";
import {
  jsonResponse,
  type OutboundStub,
  stubOutbound,
} from "../support/outbound.ts";
import { callRpc, rpcJson } from "./support.ts";

/*
  運用画面が叩く 2 つ（要件 `F-I7`・`F-F4`・計画 P7b §3-3・§5）。

  **`GET /gateway/status` の Bearer 版は `test/api/gateway.test.ts`。**
  こちらは**画面の口**（oRPC ＋ セッション）で、見るのは
  「同じ形が返る」「未ログインで 401」「2 回目が 429」の 3 点。

  **ソケットを張るテストは書かない**（計画 P4 §5）。ただし**替え玉は必ず置く**
  —— 置かないと DO が本物の Gateway へ bot token を載せて繋ぎに行く。
*/

type RpcError = {
  readonly defined?: boolean;
  readonly code?: string;
  readonly data?: unknown;
};

let authed = new Headers();
let stub: OutboundStub;

beforeEach(async () => {
  /*
    **DO を空へ戻す。** ストレージの分離はファイル単位なので、戻さないと
    「`reset` を叩いた後のテストが 429 で始まる」形でテストの順序に依存する。
  */
  await resetGatewayDO();
  authed = (await signIn()).headers;

  /*
    **握手を成立させない替え玉。** `webSocket` を持たない応答なので、DO は
    backoff に落ちる —— identify も送られないので bot token はどこへも出ない。
  */
  stub = stubOutbound([
    ["gateway.discord.gg", () => jsonResponse({ message: "no upgrade" }, 500)],
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const status = async () =>
  await rpcJson<GatewayStatus>("gateway/status", {}, authed);

const reset = async () =>
  await rpcJson<GatewayStatus & RpcError>("gateway/reset", {}, authed);

describe("認可（要件 F-F1・脅威 5）", () => {
  it.each(["gateway/status", "gateway/reset"])(
    "%s は未ログインで 401",
    async (path) => {
      expect((await callRpc(path, {})).status).toBe(401);
    },
  );

  /** **未認証の要求でソケットを張らない**（脅威 15・16）。 */
  it("401 のときは Gateway へ繋ぎに行かない", async () => {
    await callRpc("gateway/reset", {});

    expect(stub.calls).toEqual([]);
  });
});

describe("gateway.status", () => {
  it("契約の形をそのまま返す", async () => {
    const { status: code, body } = await status();

    expect(code).toBe(200);
    expect(() => GatewayStatus.parse(body)).not.toThrow();
  });

  /*
    **`curl` の口と同じ形。** あちらは `hint` を 1 つ足すが、それは
    `gatewayFatalHint` から導ける値で、画面はクライアントで引く
    （文言の出どころは `packages/contract` の 1 か所）。
  */
  it("hint は載らない（画面が自分で引く）", async () => {
    const { body } = await status();

    expect(body).not.toHaveProperty("hint");
  });

  it("繋いでいなければ idle で healthy ではない", async () => {
    const { body } = await status();

    expect(body.state).toBe("idle");
    expect(body.healthy).toBe(false);
    expect(body.connected).toBe(false);
    expect(body.resetAvailableAt).toBeNull();
  });

  it("見るだけで繋ぎに行かない", async () => {
    await status();

    expect(stub.calls).toEqual([]);
  });

  /*
    **応答に bot token が出ない**（脅威 15）。契約の `parse` が 1 段目で、
    これが 2 段目 —— デバッグ情報を足したくなる場所なので全文を見る。
  */
  it("応答のどこにも bot token が出ない", async () => {
    const { body } = await status();

    expect(JSON.stringify(body)).not.toContain(env.DISCORD_BOT_TOKEN);
    expect(JSON.stringify(body)).not.toContain(env.OFFDESK_TOKEN);
  });
});

describe("gateway.reset は 60 秒に 1 回（脅威 15）", () => {
  it("1 回目は通って繋ぎに行く", async () => {
    const { status: code } = await reset();

    expect(code).toBe(200);
    expect(stub.callsTo("gateway.discord.gg")).not.toEqual([]);
  });

  /*
    **画面の判定を信じずサーバーでも検査する**（計画 P7b §3-3）。
    クライアントはボタンを無効にするが、その判定は迂回できる。
  */
  it("2 回目は 429", async () => {
    expect((await reset()).status).toBe(200);

    expect((await reset()).status).toBe(429);
  });

  it("429 のときは繋ぎ直しに行かない", async () => {
    await reset();
    const before = stub.calls.length;

    await reset();

    expect(stub.calls.length).toBe(before);
  });

  /*
    **429 の本文にも状態が乗る**（契約の `.errors({ TOO_MANY_REQUESTS: { data } })`）。
    載っていないと、断られた画面が残り時間を出すためにもう 1 回
    `status` を叩くことになる。
  */
  it("429 の本文に状態が乗る（画面が残り時間を出せる）", async () => {
    await reset();

    const { body } = await reset();

    expect(body.defined).toBe(true);
    expect(body.code).toBe("TOO_MANY_REQUESTS");
    expect(() => GatewayStatus.parse(body.data)).not.toThrow();
    expect(GatewayStatus.parse(body.data).resetAvailableAt).toBeTypeOf(
      "number",
    );
  });

  /** **`null` = いま叩ける。** 過ぎた時刻を返すと画面がずっと無効のままになる。 */
  it("叩いた後は resetAvailableAt が 60 秒先を指す", async () => {
    const before = Date.now();
    await reset();

    const { body } = await status();

    expect(body.resetAvailableAt).toBeGreaterThan(before);
    expect(body.resetAvailableAt).toBeLessThanOrEqual(before + 61_000);
  });
});
