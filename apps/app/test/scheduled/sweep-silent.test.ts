import { env } from "cloudflare:workers";
import { INBOUND_ACTIVE_WINDOW_MS } from "@offdesk/domain";
import {
  QUEUED_SWEEP_REASON,
  SILENT_SWEEP_AFTER_MS,
  SILENT_SWEEP_REASON,
} from "@offdesk/usecase";
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
  信号が途絶えた run を畳む（要件 `F-C6`・`F-I6`）。

  **なぜ要るか。** 起動した run を終端へ動かす経路は `SessionEnd` hook 1 本しかなく、
  **cloud session からその hook は届かない** —— 同じスクリプトの `PreToolUse` と
  `Stop` は届いているのに `SessionEnd` だけが来ないので、本番の run は 1 本残らず
  `running` のまま残った。

  **なぜこの窓で畳んでよいか。** `decideInbound` は `lastSignAt` がこの窓より
  古い run を「もう死んでいる」と判断して次の 1 行で新しい run を立てる ——
  **判断はすでにしていて、台帳に書いていないだけ。**

  **時間で待たない。** 見るのは `created_at` / `activity_at` / `held_at` なので、
  種の時点で過去の時刻を入れればよい。
*/

const HOUR = 60 * 60_000;

let alpha = "";
let stub: OutboundStub;

beforeEach(async () => {
  // **同じ cron が Gateway も起こす**（替え玉が無いと本物へ繋ぎに行く）。
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

describe("窓を過ぎて信号が無い run を畳む", () => {
  it("abandoned ＋ finished_at ＋ failure_reason が入る", async () => {
    const runKey = await seedRun({
      runKey: runKeyOf(1),
      projectId: alpha,
      status: "running",
      createdAt: Date.now() - 7 * HOUR,
    });

    await runCron();

    const row = await runRow(runKey);
    expect(row?.status).toBe("abandoned");
    expect(row?.finished_at).not.toBeNull();
    expect(row?.failure_reason).toBe(SILENT_SWEEP_REASON);
  });

  /** **`waiting` も畳む。** 答えを待ったままセッションが消えるのが最も多い形。 */
  it("waiting も畳む", async () => {
    const runKey = await seedRun({
      runKey: runKeyOf(2),
      projectId: alpha,
      status: "waiting",
      createdAt: Date.now() - 7 * HOUR,
    });

    await runCron();

    expect((await runRow(runKey))?.status).toBe("abandoned");
  });

  it("窓の内側（5 時間）では畳まない", async () => {
    const runKey = await seedRun({
      runKey: runKeyOf(3),
      projectId: alpha,
      status: "running",
      createdAt: Date.now() - 5 * HOUR,
    });

    await runCron();

    expect((await runRow(runKey))?.status).toBe("running");
  });

  /** **窓は `decideInbound` と同じもの**（判断を 2 つ持たない）。 */
  it("閾値は INBOUND_ACTIVE_WINDOW_MS と同じ", () => {
    expect(SILENT_SWEEP_AFTER_MS).toBe(INBOUND_ACTIVE_WINDOW_MS);
    expect(SILENT_SWEEP_AFTER_MS).toBe(6 * HOUR);
  });

  it("run を増やさない", async () => {
    await seedRun({
      runKey: runKeyOf(4),
      projectId: alpha,
      status: "running",
      createdAt: Date.now() - 7 * HOUR,
    });
    const before = (await runRows()).length;

    await runCron();

    expect((await runRows()).length).toBe(before);
  });

  /** **無言で捨てない**（要件 `N-7`）。run 詳細の時系列に 1 行並ぶ。 */
  it("events に error が 1 行入る", async () => {
    const runKey = await seedRun({
      runKey: runKeyOf(5),
      projectId: alpha,
      status: "running",
      createdAt: Date.now() - 7 * HOUR,
    });

    await runCron();

    const events = (await eventRows()).filter((row) => row.run_key === runKey);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("error");
    expect(events[0]?.body).toContain("6 時間");
  });

  /*
    **Discord には出さない**（`sweep-queued-runs.ts` と同じ）。溜まっていた分を
    まとめて畳むときに、古いスレッドが一斉に鳴る。
  */
  it("Discord へ 1 通も出さない", async () => {
    await seedRun({
      runKey: runKeyOf(6),
      projectId: alpha,
      status: "running",
      createdAt: Date.now() - 7 * HOUR,
    });

    await runCron();

    expect(stub.callsTo("discord.com")).toEqual([]);
  });
});

describe("息をしている run は畳まない", () => {
  /*
    **`activity_at` は hook が更新する**（`PreToolUse` / `Stop`）。道具を
    呼んでいる間は数分おきに動くので、起動が古いだけの run を畳まない。
  */
  it("activity_at が新しければ、起動が古くても畳まない", async () => {
    const runKey = await seedRun({
      runKey: runKeyOf(7),
      projectId: alpha,
      status: "running",
      createdAt: Date.now() - 30 * HOUR,
      activityAt: Date.now() - 1 * HOUR,
    });

    await runCron();

    expect((await runRow(runKey))?.status).toBe("running");
  });

  /** **`held_at` は握りが 15 秒ごとに更新する**（要件 `F-C5`）。 */
  it("held_at が新しければ、起動が古くても畳まない", async () => {
    const runKey = await seedRun({
      runKey: runKeyOf(8),
      projectId: alpha,
      status: "waiting",
      createdAt: Date.now() - 30 * HOUR,
      heldAt: Date.now() - 1 * HOUR,
    });

    await runCron();

    expect((await runRow(runKey))?.status).toBe("waiting");
  });

  it.each(["done", "failed", "abandoned"])(
    "終端の %s は触らない",
    async (status) => {
      const runKey = await seedRun({
        runKey: runKeyOf(9),
        projectId: alpha,
        status,
        createdAt: Date.now() - 30 * HOUR,
      });

      await runCron();

      expect((await runRow(runKey))?.status).toBe(status);
    },
  );

  /*
    **`queued` はあちらの担当**（`sweepQueuedRuns` が 10 分で `failed` にする）。
    両方が同じ行を狙うと、run 詳細から「どちらの理由で畳まれたか」が読めなくなる。
  */
  it("queued は queued 側の掃除が failed で畳む", async () => {
    const runKey = await seedRun({
      runKey: runKeyOf(10),
      projectId: alpha,
      status: "queued",
      createdAt: Date.now() - 7 * HOUR,
    });

    await runCron();

    const row = await runRow(runKey);
    expect(row?.status).toBe("failed");
    expect(row?.failure_reason).toBe(QUEUED_SWEEP_REASON);
  });
});

describe("引いた後に信号が届いた run（レース）", () => {
  /*
    **窓の条件を UPDATE にも入れて守る。** 生きているセッションを終端にすると、
    そのセッションの `ask_human` は `closed` を受け取って作業をやめる ——
    **動いている run を殺すことになる。**

    ここでは「引いた後に `activity_at` が動いた」状態を、種の時刻と
    `before` のずれで作って代わりに見る（レースの窓そのものは作れない）。
  */
  it("abandonSilentRun は窓の内側なら false を返す", async () => {
    const { abandonSilentRun, createDb } = await import("@offdesk/db");
    const runKey = await seedRun({
      runKey: runKeyOf(11),
      projectId: alpha,
      status: "running",
      createdAt: Date.now() - 30 * HOUR,
      activityAt: Date.now() - 1 * HOUR,
    });

    const won = await abandonSilentRun(
      createDb(env.DB),
      {
        runKey,
        reason: SILENT_SWEEP_REASON,
        before: Date.now() - 6 * HOUR,
      },
      Date.now(),
    );

    expect(won).toBe(false);
    expect((await runRow(runKey))?.status).toBe("running");
  });
});
