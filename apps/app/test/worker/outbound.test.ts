import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { outboundFetch } from "../../src/worker/outbound.ts";
import { discordRestConfig } from "../../src/worker/session/launch.ts";

/*
  **これは替え玉を使わないテスト。** `vi.stubGlobal("fetch", fn)` を差すと素の関数に
  なって `this` を見なくなるので、**本物より寛容な替え玉が本物の欠陥を隠す**
  （2026-09-04 に本番で踏んだ。P2 §9-9）。ここでは実物の workerd の `fetch` を、
  **外へ出ない宛先**（127.0.0.1 の閉じたポート）に向けて呼ぶ。

  宛先は **URL として壊れた文字列**にしてある。`this` の検査は引数の処理より先に走るので、
  悪い形なら `Illegal invocation`、正しい形なら `Invalid URL` になる ——
  **接続を 1 度も試さない**ので、ログに非同期の切断が出ない。
*/

const NOT_A_URL = "%%not-a-url%%";

const failureOf = async (call: () => Promise<unknown>): Promise<string> => {
  try {
    await call();
    return "例外なし";
  } catch (error) {
    return error instanceof Error
      ? `${error.name}: ${error.message}`
      : "unknown";
  }
};

describe("outboundFetch", () => {
  it("プロパティ経由で呼んでも Illegal invocation にならない", async () => {
    const holder = { fetch: outboundFetch };

    expect(await failureOf(() => holder.fetch(NOT_A_URL))).toContain(
      "Invalid URL",
    );
  });

  it("裸のグローバルをプロパティに持たせると落ちる（これが踏んだ形）", async () => {
    const holder = { fetch };

    expect(await failureOf(() => holder.fetch(NOT_A_URL))).toContain(
      "Illegal invocation",
    );
  });
});

describe("discordRestConfig", () => {
  /*
    **アダプタが実際に受け取る値**で確かめる。`outboundFetch` 単体が正しくても、
    配線側が `{ fetch }` に戻ったらここが落ちる。
  */
  it("渡している fetch がプロパティ経由で呼べる", async () => {
    const config = discordRestConfig(env);

    expect(await failureOf(() => config.fetch(NOT_A_URL))).toContain(
      "Invalid URL",
    );
  });

  it("裸のグローバルではない", () => {
    expect(discordRestConfig(env).fetch).not.toBe(fetch);
  });
});
