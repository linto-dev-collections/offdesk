import { env } from "cloudflare:workers";
import { INBOUND_ACTIVE_WINDOW_MS } from "@offdesk/domain";
import { QUEUED_SWEEP_REASON, SILENT_SWEEP_AFTER_MS } from "@offdesk/usecase";
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

  **なぜ 2 時間か。** 実測で生きているセッションの沈黙は最長 77 分だった ——
  hook は道具を呼ぶたびに鳴るので、働いているセッションが 2 時間黙ることはない。

  **なぜ `done` か。** 成功も失敗も証拠が無く（`report(done)` を呼ぶ動線も無い）、
  終わり方はこれ 1 通りしかない。「破棄」を書くと終わった run 全部に嘘の札が付く。

  **時間で待たない。** 見るのは `created_at` / `activity_at` / `held_at` なので、
  種の時点で過去の時刻を入れればよい。
*/

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

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
  /*
    **`abandoned` にしない。** offdesk には成功も失敗も証拠が無く、終わり方は
    これ 1 通りしかないので、「破棄」を書くと終わった run 全部に嘘の札が付く
    （実際に PR まで出した run が「破棄」で並んだ）。
  */
  it("done ＋ finished_at が入り、failure_reason は空のまま", async () => {
    const runKey = await seedRun({
      runKey: runKeyOf(1),
      projectId: alpha,
      status: "running",
      createdAt: Date.now() - 3 * HOUR,
    });

    await runCron();

    const row = await runRow(runKey);
    expect(row?.status).toBe("done");
    expect(row?.finished_at).not.toBeNull();
    expect(row?.failure_reason).toBeNull();
  });

  /** **`waiting` も畳む。** 答えを待ったままセッションが消えるのが最も多い形。 */
  it("waiting も畳む", async () => {
    const runKey = await seedRun({
      runKey: runKeyOf(2),
      projectId: alpha,
      status: "waiting",
      createdAt: Date.now() - 3 * HOUR,
    });

    await runCron();

    expect((await runRow(runKey))?.status).toBe("done");
  });

  it("窓の内側（90 分）では畳まない", async () => {
    const runKey = await seedRun({
      runKey: runKeyOf(3),
      projectId: alpha,
      status: "running",
      createdAt: Date.now() - 90 * MINUTE,
    });

    await runCron();

    expect((await runRow(runKey))?.status).toBe("running");
  });

  /*
    **窓は 2 時間**（実測で生きているセッションの沈黙は最長 77 分）。
    `INBOUND_ACTIVE_WINDOW_MS`（6 時間）より短いので、素の文の判定は
    **こちらが先に決める**（畳んだ run は終端になり `decideInbound` が
    終端を先に見る）。あちらは cron が止まったときの保険。
  */
  it("閾値は 2 時間で、素の文の窓より短い", () => {
    expect(SILENT_SWEEP_AFTER_MS).toBe(2 * HOUR);
    expect(SILENT_SWEEP_AFTER_MS).toBeLessThan(INBOUND_ACTIVE_WINDOW_MS);
  });

  it("run を増やさない", async () => {
    await seedRun({
      runKey: runKeyOf(4),
      projectId: alpha,
      status: "running",
      createdAt: Date.now() - 3 * HOUR,
    });
    const before = (await runRows()).length;

    await runCron();

    expect((await runRows()).length).toBe(before);
  });

  /*
    **無言で捨てない**（要件 `N-7`）。`failure_reason` には書けない
    （`runs_failure_reason_ck`）ので、掃除で畳んだことを持つのはこの 1 行だけ。
    **`error` にしない** —— 画面で赤い「エラー」が出ると、状態を `done` に
    した意味が無くなる。
  */
  it("events に done が 1 行入る", async () => {
    const runKey = await seedRun({
      runKey: runKeyOf(5),
      projectId: alpha,
      status: "running",
      createdAt: Date.now() - 3 * HOUR,
    });

    await runCron();

    const events = (await eventRows()).filter((row) => row.run_key === runKey);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("done");
    expect(events[0]?.body).toContain("2 時間");
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
      createdAt: Date.now() - 3 * HOUR,
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
  it("finishSilentRun は窓の内側なら false を返す", async () => {
    const { createDb, finishSilentRun } = await import("@offdesk/db");
    const runKey = await seedRun({
      runKey: runKeyOf(11),
      projectId: alpha,
      status: "running",
      createdAt: Date.now() - 30 * HOUR,
      activityAt: Date.now() - 1 * HOUR,
    });

    const won = await finishSilentRun(
      createDb(env.DB),
      { runKey, before: Date.now() - 2 * HOUR },
      Date.now(),
    );

    expect(won).toBe(false);
    expect((await runRow(runKey))?.status).toBe("running");
  });
});
