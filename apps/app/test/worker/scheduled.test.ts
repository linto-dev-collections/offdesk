import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../../src/worker/index.ts";

/*
  **cron を宣言したら `scheduled` も出す。** 無いと Cloudflare は 5 分ごとに
  `Handler does not export a scheduled() function` を記録し続け、本当のエラーが
  その中に埋もれる。中身は P8 で入るので、ここで見るのは呼べる形かどうかだけ。
*/
describe("scheduled", () => {
  it("default export が scheduled を持ち、宣言した cron 式で呼べる", async () => {
    expect(typeof worker.scheduled).toBe("function");

    const ctx = createExecutionContext();
    await worker.scheduled(
      createScheduledController({ cron: "*/5 * * * *" }),
      env,
      ctx,
    );

    await waitOnExecutionContext(ctx);
  });
});
