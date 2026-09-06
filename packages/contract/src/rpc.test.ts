import { describe, expect, it } from "vitest";
import { RPC_PREFIX, rpcUrl } from "./rpc.ts";

/*
  **相対パスを `RPCLink` に渡すと動かない**（P1 §9-7）。

  oRPC は内部で `new URL(baseUrl)` を呼ぶので、`"/rpc"` では
  `TypeError: Invalid URL` になり、リクエストがブラウザから 1 度も出ない。
  **`new URL()` が受け付ける形かどうか ＝ 絶対 URL かどうか**なので、
  ここではその性質を直接見る。
*/

const ABSOLUTE = /^https?:\/\/[^/]+\//;

describe("rpcUrl", () => {
  it("本番のオリジンから絶対 URL を作る", () => {
    expect(rpcUrl("https://offdesk.example.workers.dev")).toBe(
      "https://offdesk.example.workers.dev/rpc",
    );
  });

  it("ローカルでも同じ形", () => {
    expect(rpcUrl("http://localhost:5173")).toBe("http://localhost:5173/rpc");
  });

  it("末尾の `/` があってもスラッシュが二重にならない", () => {
    expect(rpcUrl("https://example.test/")).toBe("https://example.test/rpc");
    expect(rpcUrl("https://example.test///")).toBe("https://example.test/rpc");
  });

  /*
    **これが踏んだバグそのもの。** `RPCLink` の `url` は絶対 URL でなければならず、
    相対パスだと oRPC の `new URL()` が落ちる。
  */
  it("必ず絶対 URL になる", () => {
    for (const origin of [
      "https://offdesk.example.workers.dev",
      "http://localhost:5173",
      "http://127.0.0.1:8787",
    ]) {
      expect(rpcUrl(origin)).toMatch(ABSOLUTE);
    }
  });

  it("RPC_PREFIX 単体は絶対 URL ではない（そのまま渡してはいけない）", () => {
    expect(RPC_PREFIX).not.toMatch(ABSOLUTE);
  });
});

describe("RPC_PREFIX", () => {
  /*
    `apps/app/wrangler.jsonc` と `packages/infra/alchemy.run.ts` の
    `run_worker_first` にこのパスが入っていないと、拡張子を持たない POST が
    SPA フォールバックに吸われる。**値を動かすときは 3 か所を揃える。**
  */
  it("`/` で始まり、末尾に `/` を付けない", () => {
    expect(RPC_PREFIX.startsWith("/")).toBe(true);
    expect(RPC_PREFIX.endsWith("/")).toBe(false);
  });
});
