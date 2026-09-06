import type { DashboardOutput } from "@offdesk/contract";
import {
  DASHBOARD_ASK_LIMIT,
  DASHBOARD_FAILURE_LIMIT,
  DASHBOARD_LIVE_LIMIT,
} from "@offdesk/usecase";
import { beforeEach, describe, expect, it } from "vitest";
import { signIn } from "../auth/support.ts";
import { seedTwoProjects } from "../db/support.ts";
import {
  askIdOf,
  callRpc,
  rpcJson,
  runKeyOf,
  seedAsk,
  seedRun,
} from "./support.ts";

const NOW = Date.now();

let alpha = "";
let authed = new Headers();

beforeEach(async () => {
  alpha = (await seedTwoProjects()).alpha;
  authed = (await signIn()).headers;
});

const summary = async () =>
  await rpcJson<DashboardOutput>("dashboard/summary", {}, authed);

describe("POST /rpc/dashboard.summary", () => {
  it("未ログインなら 401", async () => {
    expect((await callRpc("dashboard/summary", {})).status).toBe(401);
  });

  /** 台帳がまだ空でも 3 枚の枠は返る（画面としては正しい）。 */
  it("台帳が空でも 3 枚が返る", async () => {
    const { status, body } = await summary();

    expect(status).toBe(200);
    expect(body).toEqual({
      liveRuns: [],
      pendingAsks: [],
      recentFailures: [],
    });
  });
});

describe("走っている run", () => {
  it("終端でない 3 状態だけが入る", async () => {
    let index = 0;
    for (const status of [
      "queued",
      "running",
      "waiting",
      "done",
      "failed",
      "abandoned",
    ]) {
      index += 1;
      await seedRun({
        runKey: runKeyOf(index),
        projectId: alpha,
        status,
        threadId: null,
        createdAt: NOW - index * 1000,
      });
    }

    const { body } = await summary();

    expect(body.liveRuns.map((run) => run.status)).toEqual([
      "queued",
      "running",
      "waiting",
    ]);
  });

  it("新しい順に並ぶ", async () => {
    await seedRun({
      runKey: runKeyOf(1),
      projectId: alpha,
      threadId: null,
      createdAt: NOW - 3000,
    });
    await seedRun({
      runKey: runKeyOf(2),
      projectId: alpha,
      threadId: null,
      createdAt: NOW - 1000,
    });

    expect((await summary()).body.liveRuns.map((run) => run.runKey)).toEqual([
      runKeyOf(2),
      runKeyOf(1),
    ]);
  });

  it("10 件で止まる", async () => {
    for (let index = 1; index <= DASHBOARD_LIVE_LIMIT + 5; index += 1) {
      await seedRun({
        runKey: runKeyOf(index),
        projectId: alpha,
        threadId: null,
        createdAt: NOW - index * 1000,
      });
    }

    expect((await summary()).body.liveRuns).toHaveLength(DASHBOARD_LIVE_LIMIT);
  });

  /*
    **一覧と同じ形で返る。** カードと一覧で列が違うと、同じ run が
    2 通りに見える（片方だけ残量が出ない、など）。
  */
  it("一覧と同じ 1 行の形（プロジェクト名・残量・切った prompt）", async () => {
    await seedRun({
      runKey: runKeyOf(1),
      projectId: alpha,
      prompt: "あ".repeat(300),
      threadId: null,
      ctx: { usedTokens: 50_000, at: NOW, model: "claude-sonnet-5" },
    });

    const run = (await summary()).body.liveRuns[0];

    expect(run?.projectName).toBe("offdesk-test");
    expect(run?.promptTruncated).toBe(true);
    expect(run?.contextPercent).toBe(5);
  });

  /** 期間で切らない（走っているものは古くても出す）。 */
  it("30 日より古くても走っていれば出す", async () => {
    await seedRun({
      runKey: runKeyOf(1),
      projectId: alpha,
      threadId: null,
      createdAt: NOW - 100 * 24 * 60 * 60 * 1000,
    });

    expect((await summary()).body.liveRuns).toHaveLength(1);
  });
});

describe("直近の失敗", () => {
  it("failed と abandoned だけが入る", async () => {
    let index = 0;
    for (const status of ["done", "failed", "abandoned", "running"]) {
      index += 1;
      await seedRun({
        runKey: runKeyOf(index),
        projectId: alpha,
        status,
        threadId: null,
        createdAt: NOW - index * 1000,
      });
    }

    const { body } = await summary();

    expect(new Set(body.recentFailures.map((run) => run.status))).toEqual(
      new Set(["failed", "abandoned"]),
    );
  });

  it("5 件で止まる", async () => {
    for (let index = 1; index <= DASHBOARD_FAILURE_LIMIT + 3; index += 1) {
      await seedRun({
        runKey: runKeyOf(index),
        projectId: alpha,
        status: "failed",
        threadId: null,
        createdAt: NOW - index * 1000,
      });
    }

    expect((await summary()).body.recentFailures).toHaveLength(
      DASHBOARD_FAILURE_LIMIT,
    );
  });

  it("新しい順に並ぶ", async () => {
    await seedRun({
      runKey: runKeyOf(1),
      projectId: alpha,
      status: "failed",
      threadId: null,
      createdAt: NOW - 3000,
    });
    await seedRun({
      runKey: runKeyOf(2),
      projectId: alpha,
      status: "abandoned",
      threadId: null,
      createdAt: NOW - 1000,
    });

    expect(
      (await summary()).body.recentFailures.map((run) => run.runKey),
    ).toEqual([runKeyOf(2), runKeyOf(1)]);
  });
});

describe("未回答の ask", () => {
  beforeEach(async () => {
    await seedRun({
      runKey: runKeyOf(1),
      projectId: alpha,
      threadId: "444444444444444444",
    });
  });

  it("答えが入っていない問いだけが入る", async () => {
    await seedAsk({
      askId: askIdOf(1),
      runKey: runKeyOf(1),
      question: "未回答",
      createdAt: NOW - 1000,
    });
    await seedAsk({
      askId: askIdOf(2),
      runKey: runKeyOf(1),
      question: "回答済み",
      answer: "はい",
      answeredAt: NOW,
      createdAt: NOW - 2000,
    });

    const { body } = await summary();

    expect(body.pendingAsks.map((ask) => ask.question)).toEqual(["未回答"]);
  });

  it("新しい順に並ぶ", async () => {
    await seedAsk({
      askId: askIdOf(1),
      runKey: runKeyOf(1),
      question: "古い",
      createdAt: NOW - 3000,
    });
    await seedAsk({
      askId: askIdOf(2),
      runKey: runKeyOf(1),
      question: "新しい",
      createdAt: NOW - 1000,
    });

    expect(
      (await summary()).body.pendingAsks.map((ask) => ask.question),
    ).toEqual(["新しい", "古い"]);
  });

  it("10 件で止まる", async () => {
    for (let index = 1; index <= DASHBOARD_ASK_LIMIT + 4; index += 1) {
      await seedAsk({
        askId: askIdOf(index),
        runKey: runKeyOf(1),
        question: `質問 ${index}`,
        createdAt: NOW - index * 1000,
      });
    }

    expect((await summary()).body.pendingAsks).toHaveLength(
      DASHBOARD_ASK_LIMIT,
    );
  });

  /*
    **これがいちばん気づきにくい詰まり**（`asks.message_id` が NULL）。
    問いは立っているのに Discord に出ていないので、待っている側からは
    「Claude が黙っている」に見える。
  */
  it("Discord へ出せていない問いには印が付く", async () => {
    await seedAsk({
      askId: askIdOf(1),
      runKey: runKeyOf(1),
      question: "出せていない",
      messageId: null,
    });

    expect((await summary()).body.pendingAsks[0]?.postedToDiscord).toBe(false);
  });

  it("Discord へ出せた問いには印が付かない", async () => {
    await seedAsk({
      askId: askIdOf(1),
      runKey: runKeyOf(1),
      question: "出せた",
      messageId: "123456789012345678",
    });

    expect((await summary()).body.pendingAsks[0]?.postedToDiscord).toBe(true);
  });

  it("プロジェクト名とスレッドの URL が入る", async () => {
    await seedAsk({
      askId: askIdOf(1),
      runKey: runKeyOf(1),
      question: "?",
    });

    const ask = (await summary()).body.pendingAsks[0];

    expect(ask?.projectName).toBe("offdesk-test");
    expect(ask?.threadUrl).toBe(
      "https://discord.com/channels/999999999999999999/444444444444444444",
    );
  });

  /** 選択肢は数だけ（本文はカードに収まらない）。 */
  it("選択肢は数だけ返る", async () => {
    await seedAsk({
      askId: askIdOf(1),
      runKey: runKeyOf(1),
      question: "?",
      options: ["A", "B", "C"],
    });

    const { body } = await summary();

    expect(body.pendingAsks[0]?.optionCount).toBe(3);
    expect(JSON.stringify(body.pendingAsks)).not.toContain('"A"');
  });
});
