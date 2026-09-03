import { env } from "cloudflare:workers";
import { HealthOutput } from "@offdesk/contract";
import { describe, expect, it } from "vitest";
import app from "../../src/worker/index.ts";

/*
  Hono の `app.fetch` を直接呼ぶ（`cloudflare:test` の `SELF` は 0.22 で deprecated）。

  **静的アセットの SPA フォールバックとの取り合い（`run_worker_first`）は
  ここでは見ていない。** あれはランタイムのアセット層の話で、実際にデプロイして
  URL を叩く（P0 の完了条件）ことと、設定の一覧を突き合わせるテスト
  （P8 の `run-worker-first`）で見る。
*/
const health = async (): Promise<Response> =>
  await app.fetch(new Request("http://localhost:5173/api/health"), env);

describe("GET /api/health", () => {
  it("200 を返す", async () => {
    expect((await health()).status).toBe(200);
  });

  it('本文は {"status":"ok"}', async () => {
    expect(await (await health()).json()).toEqual({ status: "ok" });
  });

  it("返す本文が契約（HealthOutput）を満たす", async () => {
    const parsed = HealthOutput.safeParse(await (await health()).json());

    expect(parsed.success).toBe(true);
  });

  it("JSON として返す", async () => {
    expect((await health()).headers.get("content-type")).toContain(
      "application/json",
    );
  });
});
