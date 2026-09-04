import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/worker/index.ts";
import { signIn } from "../auth/support.ts";
import { ORIGIN } from "../discord/support.ts";
import { resetGatewayDO } from "../support/gateway.ts";
import {
  jsonResponse,
  type OutboundStub,
  stubOutbound,
} from "../support/outbound.ts";

/*
  `/gateway/*`（要件 `F-I7`・計画 P4 §3-7）。

  **Ed25519 ではなく Bearer / セッションで守る**（plans/security.md 脅威 1）——
  Discord から来るリクエストではないので、Discord の署名で守ろうとしない。

  **ソケットを張るテストは書かない**（計画 P4 §5）。ここで見るのは口の守りと
  応答の形だけで、遷移そのものは `packages/domain/src/gateway.test.ts`。
  ただし**替え玉は必ず置く** —— 置かないと DO が本物の Gateway へ
  bot token を載せて繋ぎに行く。
*/

const TOKEN = "test-offdesk-token-0123456789abcdef";

let stub: OutboundStub;

beforeEach(async () => {
  /*
    **DO を空へ戻す。** ストレージの分離はファイル単位なので、戻さないと
    テストの順序に依存する（`reset` を叩いた後の `ensure` は backoff の途中なので
    繋ぎに行かない —— 2026-09-04 に実測。`support/gateway.ts` に記録）。
  */
  await resetGatewayDO();

  /*
    **握手を成立させない替え玉。** `webSocket` を持たない応答なので、DO は
    「WebSocket に切り替わらなかった」として backoff に落ちる ——
    identify も送られないので bot token はどこへも出ない。
  */
  stub = stubOutbound([
    ["gateway.discord.gg", () => jsonResponse({ message: "no upgrade" }, 500)],
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const call = async (
  path: string,
  overrides: {
    readonly method?: string;
    readonly authorization?: string | null;
    readonly headers?: Headers;
  } = {},
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const headers = new Headers(overrides.headers);

  /*
    **「ヘッダを付けない」を `undefined` で表さない**（計画 README §2-3）。
    既定値つきの引数に `undefined` を渡すと既定値が入るので、
    「送っているのに 401 を期待する」テストが通ってしまう。
  */
  const authorization =
    overrides.authorization === undefined
      ? `Bearer ${TOKEN}`
      : overrides.authorization;
  if (authorization !== null) headers.set("authorization", authorization);

  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: overrides.method ?? "GET",
      headers,
    }),
    env,
    ctx,
  );
  const text = await response.text();
  await waitOnExecutionContext(ctx);

  return {
    status: response.status,
    body: text.startsWith("{")
      ? (JSON.parse(text) as Record<string, unknown>)
      : { text },
  };
};

describe("認可（要件 F-I7）", () => {
  it("Bearer で通る", async () => {
    const { status, body } = await call("/gateway/status");

    expect(status).toBe(200);
    expect(body.state).toBeTypeOf("string");
  });

  it("ログイン済みのセッションでも通る", async () => {
    const { headers } = await signIn();

    const { status } = await call("/gateway/status", {
      // **Bearer は付けない。** セッションだけで通ることを見る。
      authorization: null,
      headers,
    });

    expect(status).toBe(200);
  });

  it.each([
    ["ヘッダが無い", null],
    ["空の Bearer", "Bearer "],
    ["違う token", "Bearer wrong-token-0123456789abcdef"],
    ["Basic", "Basic dXNlcjpwYXNz"],
  ])("%s なら 401", async (_label, authorization) => {
    const { status } = await call("/gateway/status", { authorization });

    expect(status).toBe(401);
  });

  it.each(["/gateway/status", "/gateway/reset", "/gateway/ensure"])(
    "%s は未認証で 401",
    async (path) => {
      const { status } = await call(path, {
        method: "POST",
        authorization: null,
      });

      expect(status).toBe(401);
    },
  );

  /** **未認証のリクエストでソケットを張らない**（脅威 15・16）。 */
  it("401 のときは Gateway へ繋ぎに行かない", async () => {
    await call("/gateway/reset", { method: "POST", authorization: null });

    expect(stub.calls).toEqual([]);
  });
});

describe("status の応答（P7b の運用画面がそのまま出す）", () => {
  it("契約の形をすべて持つ", async () => {
    const { body } = await call("/gateway/status");

    expect(Object.keys(body).sort()).toEqual([
      "connected",
      "fatalReason",
      "healthy",
      "hint",
      "lastEventAt",
      "resetAvailableAt",
      "state",
    ]);
  });

  it("繋いでいなければ idle で healthy ではない", async () => {
    const { body } = await call("/gateway/status");

    expect(body.state).toBe("idle");
    expect(body.healthy).toBe(false);
    expect(body.connected).toBe(false);
    expect(body.fatalReason).toBeNull();
    expect(body.hint).toBeNull();
  });

  /*
    **`status` に bot token を出さない**（計画 P4 §3-7）。当然だが、デバッグ情報を
    足すときに混ぜやすい場所なので、応答の全文を見て確かめる ——
    契約（`GatewayStatus`）が `parse` で落とすのが 1 段目で、これが 2 段目。
  */
  it("応答のどこにも bot token が出ない", async () => {
    const { body } = await call("/gateway/status");

    expect(JSON.stringify(body)).not.toContain(env.DISCORD_BOT_TOKEN);
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it("status では繋ぎに行かない（見るだけ）", async () => {
    await call("/gateway/status");

    expect(stub.calls).toEqual([]);
  });
});

describe("reset は 60 秒に 1 回（脅威 15）", () => {
  /*
    **連打で identify のレート制限（1 日 1000 回）を使い切らせない。**
    P7b の画面もクライアント側で判定するが、**サーバーでも必ず検査する** ——
    画面の判定は迂回できる。
  */
  it("1 回目は通り、2 回目は 429", async () => {
    const first = await call("/gateway/reset", { method: "POST" });
    expect(first.status).toBe(200);

    const second = await call("/gateway/reset", { method: "POST" });
    expect(second.status).toBe(429);
  });

  it("429 のときは繋ぎ直しに行かない", async () => {
    await call("/gateway/reset", { method: "POST" });
    const before = stub.calls.length;

    await call("/gateway/reset", { method: "POST" });

    expect(stub.calls.length).toBe(before);
  });

  /** **`null` = いま叩ける。** 過ぎた時刻を返すと画面がずっと無効のままになる。 */
  it("叩く前は resetAvailableAt が null", async () => {
    const { body } = await call("/gateway/status");

    expect(body.resetAvailableAt).toBeNull();
  });

  it("叩いた後は resetAvailableAt が 60 秒先を指す", async () => {
    const before = Date.now();
    await call("/gateway/reset", { method: "POST" });

    const { body } = await call("/gateway/status");

    expect(body.resetAvailableAt).toBeGreaterThan(before);
    expect(body.resetAvailableAt).toBeLessThanOrEqual(before + 60_000 + 1_000);
  });

  it("429 の本文も status と同じ形を持つ（画面が残り時間を出せる）", async () => {
    await call("/gateway/reset", { method: "POST" });

    const { body } = await call("/gateway/reset", { method: "POST" });

    expect(body.state).toBeTypeOf("string");
    expect(body.resetAvailableAt).toBeTypeOf("number");
  });
});

describe("ensure（P8 の cron が叩く）", () => {
  /*
    **DO は自分では起動できない**（要件 `F-I2`）。alarm ごと evict された状態から
    戻す保険がこれ。**ここで実際に張りに行く**ので、替え玉が呼ばれることを見る。
  */
  it("繋ぎに行く", async () => {
    const { status } = await call("/gateway/ensure", { method: "POST" });

    expect(status).toBe(200);
    expect(stub.callsTo("gateway.discord.gg")).not.toEqual([]);
  });

  /*
    **`wss://` を渡さない**（計画 P4 §3-3・§7）。`fetch` に渡すと
    `Fetch API cannot load: wss://…` で即座に落ち、ソケットが開かないので
    「原因不明で繋がらない」にしか見えない。
  */
  it("https:// で、版とエンコーディングが付いている", async () => {
    await call("/gateway/ensure", { method: "POST" });

    const [connect] = stub.callsTo("gateway.discord.gg");
    expect(connect?.url).toMatch(/^https:\/\//);
    expect(connect?.url).toContain("v=10");
    expect(connect?.url).toContain("encoding=json");
  });

  it("Upgrade: websocket を付けている", async () => {
    await call("/gateway/ensure", { method: "POST" });

    const [connect] = stub.callsTo("gateway.discord.gg");
    expect(connect?.headers.upgrade).toBe("websocket");
  });

  /*
    **握手が成立しなかったら backoff に落ちる。** ここが `idle` のままだと
    alarm が張られず、cron が来るまで（5 分）誰も張り直さない。
  */
  it("握手が成立しなければ backoff になる", async () => {
    const { body } = await call("/gateway/ensure", { method: "POST" });

    expect(body.state).toBe("backoff");
    expect(body.connected).toBe(false);
  });
});

describe("知らないパス", () => {
  it("404 を返す（DO の中まで届いていることの裏）", async () => {
    const { status } = await call("/gateway/unknown");

    expect(status).toBe(404);
  });
});
