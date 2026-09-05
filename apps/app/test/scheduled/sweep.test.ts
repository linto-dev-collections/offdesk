import { env } from "cloudflare:workers";
import { QUEUED_SWEEP_AFTER_MS, QUEUED_SWEEP_REASON } from "@offdesk/usecase";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eventRows, runRows, seedTwoProjects } from "../db/support.ts";
import { runKeyOf, seedRun } from "../rpc/support.ts";
import { resetGatewayDO } from "../support/gateway.ts";
import {
  jsonResponse,
  type OutboundStub,
  stubOutbound,
} from "../support/outbound.ts";
import { runCron } from "./support.ts";

/*
  起動が完了しなかった run を畳む（要件 `F-I6`・計画 P8 §3-2・§5）。

  **なぜ要るか。** `/offdesk` の続きは `waitUntil` の中で走って**応答から 30 秒**で
  切られる。途中で切れると台帳に `queued` の行だけが残り、`decideInbound` からは
  「作業中」に見えるので、**以後そのスレッドの発言が全部そこへ吸い込まれて
  誰も読まない。** 畳んでおけば次の 1 行が `restart` として拾う。

  **時間で待たない。** 閾値は `created_at` で見るので、種の時点で過去の時刻を
  入れればよい。
*/

const MINUTE = 60_000;

let alpha = "";
let stub: OutboundStub;

beforeEach(async () => {
  /*
    **同じ cron が Gateway も起こす。** 替え玉を置かないと DO が本物の
    Gateway へ bot token を載せて繋ぎに行く（この掃除のテストでも要る）。
  */
  await resetGatewayDO();
  stub = stubOutbound([
    ["gateway.discord.gg", () => jsonResponse({ message: "no upgrade" }, 500)],
  ]);
  alpha = (await seedTwoProjects()).alpha;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const runRow = async (runKey: string) =>
  (await runRows()).find((row) => row.run_key === runKey);

describe("10 分を過ぎた queued を畳む", () => {
  it("failed ＋ finished_at ＋ failure_reason が入る", async () => {
    const runKey = await seedRun({
      runKey: runKeyOf(1),
      projectId: alpha,
      status: "queued",
      createdAt: Date.now() - 11 * MINUTE,
    });

    await runCron();

    const row = await runRow(runKey);
    expect(row?.status).toBe("failed");
    expect(row?.finished_at).not.toBeNull();
    expect(row?.failure_reason).toBe(QUEUED_SWEEP_REASON);
  });

  /** **閾値は 10 分**（`waitUntil` の 30 秒より十分長く、人が待てる長さ）。 */
  it("9 分では畳まない", async () => {
    const runKey = await seedRun({
      runKey: runKeyOf(2),
      projectId: alpha,
      status: "queued",
      createdAt: Date.now() - 9 * MINUTE,
    });

    await runCron();

    expect((await runRow(runKey))?.status).toBe("queued");
  });

  it("閾値は packages/usecase の定数と同じ（10 分）", () => {
    expect(QUEUED_SWEEP_AFTER_MS).toBe(10 * MINUTE);
  });

  /*
    **起こし直さない**（計画 P8 §3-2 の 3）。実は起動できていた場合に
    2 本目が立つ —— 畳むだけにしておけば、次の 1 行が `restart` として拾う。
  */
  it("run を増やさない", async () => {
    await seedRun({
      runKey: runKeyOf(3),
      projectId: alpha,
      status: "queued",
      createdAt: Date.now() - 11 * MINUTE,
    });
    const before = (await runRows()).length;

    await runCron();

    expect((await runRows()).length).toBe(before);
  });

  /** **無言で捨てない**（要件 `N-7`）。run 詳細の時系列に 1 行並ぶ。 */
  it("events に error が 1 行入る", async () => {
    const runKey = await seedRun({
      runKey: runKeyOf(4),
      projectId: alpha,
      status: "queued",
      createdAt: Date.now() - 11 * MINUTE,
    });

    await runCron();

    const events = (await eventRows()).filter((row) => row.run_key === runKey);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("error");
    expect(events[0]?.body).toContain("10 分");
  });

  /*
    **Discord には出さない**（要件 §3-2 の「通知は作らない」）。
    気づく手段は画面 —— ここで出すと、掃除が鳴るたびにスレッドが荒れる。
  */
  it("Discord へ 1 通も出さない", async () => {
    await seedRun({
      runKey: runKeyOf(5),
      projectId: alpha,
      status: "queued",
      createdAt: Date.now() - 11 * MINUTE,
    });

    await runCron();

    expect(stub.callsTo("discord.com")).toEqual([]);
  });

  it("2 本以上あればまとめて畳む", async () => {
    const keys = [runKeyOf(6), runKeyOf(7)];
    for (const runKey of keys) {
      await seedRun({
        runKey,
        projectId: alpha,
        status: "queued",
        createdAt: Date.now() - 20 * MINUTE,
      });
    }

    await runCron();

    for (const runKey of keys) {
      expect((await runRow(runKey))?.status).toBe("failed");
    }
  });
});

describe("queued 以外は触らない", () => {
  it.each(["running", "waiting", "done", "failed", "abandoned"])(
    "%s の run は畳まない",
    async (status) => {
      const runKey = await seedRun({
        runKey: runKeyOf(8),
        projectId: alpha,
        status,
        createdAt: Date.now() - 60 * MINUTE,
      });

      await runCron();

      expect((await runRow(runKey))?.status).toBe(status);
    },
  );
});

describe("引いた後に動き出していた run（レース）", () => {
  /*
    **`queued` を条件に入れた UPDATE で守る**（`failQueuedRun`）。
    条件無しの UPDATE にすると、`waitUntil` が完了して `running` になった run を
    `failed` で塗り潰す —— そうなると働いている run が終端になり、
    **次の 1 行が `restart` として 2 本目を立てる**（要件 `I-13`）。

    ここでは「掃除の直前に `running` へ進んだ」状態を、
    種の `status` で作って代わりに見る（レースの窓そのものは作れない）。
  */
  it("running へ進んでいれば畳まず、error も残さない", async () => {
    const runKey = await seedRun({
      runKey: runKeyOf(9),
      projectId: alpha,
      status: "running",
      createdAt: Date.now() - 11 * MINUTE,
    });

    await runCron();

    expect((await runRow(runKey))?.status).toBe("running");
    expect((await eventRows()).filter((row) => row.run_key === runKey)).toEqual(
      [],
    );
  });

  /** UPDATE そのものが条件付きであること（掃除を通さずに直接見る）。 */
  it("failQueuedRun は queued でなければ false を返す", async () => {
    const { createDb, failQueuedRun } = await import("@offdesk/db");
    const runKey = await seedRun({
      runKey: runKeyOf(10),
      projectId: alpha,
      status: "running",
    });

    const won = await failQueuedRun(
      createDb(env.DB),
      runKey,
      QUEUED_SWEEP_REASON,
      Date.now(),
    );

    expect(won).toBe(false);
    expect((await runRow(runKey))?.status).toBe("running");
  });
});
