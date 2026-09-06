import { describe, expect, it } from "vitest";
import {
  RUN_SINCE_DAYS_DEFAULT,
  RUN_SINCE_DAYS_MAX,
  RUN_STATUSES,
  RunListQuery,
  RunSummary,
  TimelineEntry,
} from "./run.ts";

/*
  一覧の入力（要件 `F-F2`・plans/security.md 脅威 11）。

  **これは URL の検証と oRPC の入力検証の両方**（計画 P7a §3-4）。
  1 本にしてあるので、「URL だけ緩い」状態が作れない。
*/

const DEFAULTS = {
  sinceDays: RUN_SINCE_DAYS_DEFAULT,
  page: 1,
  sort: "createdAt",
  order: "desc",
} as const;

describe("RunListQuery", () => {
  it("空の入力は既定値になる", () => {
    expect(RunListQuery.parse({})).toEqual(DEFAULTS);
  });

  it("正しい値はそのまま通る", () => {
    expect(
      RunListQuery.parse({
        projectId: "p1",
        status: "waiting",
        sinceDays: 7,
        page: 3,
        sort: "updatedAt",
        order: "asc",
      }),
    ).toEqual({
      projectId: "p1",
      status: "waiting",
      sinceDays: 7,
      page: 3,
      sort: "updatedAt",
      order: "asc",
    });
  });

  it.each(RUN_STATUSES)("status=%s を受ける", (status) => {
    expect(RunListQuery.parse({ status }).status).toBe(status);
  });

  /*
    **どんな入力でも parse は失敗しない**（全フィールドが `.catch()` か
    `.default()` を持つ）。これが「不正な search params で画面が壊れない」の
    土台で、**1 つでも `.catch()` を落とすとここが落ちる。**
  */
  it.each([
    ["page が文字列", { page: "abc" }, { page: 1 }],
    ["page が 0", { page: 0 }, { page: 1 }],
    ["page が負", { page: -5 }, { page: 1 }],
    ["page が小数", { page: 1.5 }, { page: 1 }],
    ["page が null", { page: null }, { page: 1 }],
    ["page が真偽値の false", { page: false }, { page: 1 }],
    ["page がオブジェクト", { page: {} }, { page: 1 }],
    ["page が 2 個来た（配列）", { page: [2, 3] }, { page: 1 }],
    ["sinceDays が 0", { sinceDays: 0 }, { sinceDays: RUN_SINCE_DAYS_DEFAULT }],
    [
      "sinceDays が上限超え",
      { sinceDays: RUN_SINCE_DAYS_MAX + 1 },
      { sinceDays: RUN_SINCE_DAYS_DEFAULT },
    ],
    ["sort が allowlist 外", { sort: "prompt" }, { sort: "createdAt" }],
    [
      "sort が SQL 片",
      { sort: "created_at; DROP TABLE runs" },
      { sort: "createdAt" },
    ],
    ["order が allowlist 外", { order: "sideways" }, { order: "desc" }],
  ])("%s なら既定値に倒れる", (_name, input, expected) => {
    expect(RunListQuery.parse(input)).toEqual({ ...DEFAULTS, ...expected });
  });

  it.each([
    ["status が allowlist 外", { status: "nope" }],
    ["status が数値", { status: 1 }],
    ["projectId が空文字", { projectId: "" }],
    ["projectId が数値", { projectId: 1 }],
  ])("%s なら絞り込みが外れる", (_name, input) => {
    expect(RunListQuery.parse(input)).toEqual(DEFAULTS);
  });

  /*
    **`z.coerce.number()` は JS の `Number()` そのもの**（2026-09-05 に実測）。
    要素 1 つの配列は数値になる（`Number([2]) === 2`）ので、
    `page=[2]` は 2 として通る —— **2 個来たときは `NaN` で既定値に倒れる**
    （上の表の「2 個来た」）。URL からこの形が来ることは無いが、
    手で作った RPC 要求では起こりうるので、どちらも安全側に落ちることを見ておく。
  */
  it("要素 1 つの配列は数値として通る（Number() の仕様）", () => {
    expect(RunListQuery.parse({ page: [2] }).page).toBe(2);
  });

  /** 数字が文字列で来ることがある（URL から来る値）。 */
  it("page と sinceDays は数字の文字列を受ける", () => {
    expect(RunListQuery.parse({ page: "3", sinceDays: "90" })).toEqual({
      ...DEFAULTS,
      page: 3,
      sinceDays: 90,
    });
  });

  /** **知らないキーは落とす。** 画面側では残るが（TanStack Router の仕組み）、ここで消える。 */
  it("知らないキーは落とす", () => {
    expect(RunListQuery.parse({ nope: 1, page: 2 })).toEqual({
      ...DEFAULTS,
      page: 2,
    });
  });

  it("上限そのものは通る", () => {
    expect(
      RunListQuery.parse({ sinceDays: RUN_SINCE_DAYS_MAX }).sinceDays,
    ).toBe(RUN_SINCE_DAYS_MAX);
  });
});

describe("RunSummary", () => {
  const summary = {
    runKey: "OFFDESK-1111111111111111",
    projectId: "p1",
    projectName: "offdesk-test",
    status: "running",
    prompt: "ping",
    promptTruncated: false,
    threadUrl: null,
    createdAt: 1,
    finishedAt: null,
    contextPercent: null,
    contextUsedTokens: null,
    contextWindowTokens: 200_000,
    contextWindowKnown: false,
  };

  it("null を許すのは 4 つだけ", () => {
    expect(RunSummary.parse(summary)).toEqual(summary);
  });

  /*
    **分母は必ず入る**（`null` を許さない）。要件 `F-D4` は「引けなくても
    200k を仮に置く」と決めているので、`null` は「引けなかった」の表現にならない ——
    それを言うのは `contextWindowKnown` の役目。
  */
  it.each(["contextWindowTokens", "contextWindowKnown"])(
    "%s に null は入らない",
    (key) => {
      expect(() => RunSummary.parse({ ...summary, [key]: null })).toThrow();
    },
  );

  /*
    **キーが消えることを許さない。** `undefined` を通すと、出力検証が
    「無い」と「付け忘れ」を区別できなくなる（`MeOutput.imageUrl` と同じ判断）。
  */
  it.each([
    "threadUrl",
    "finishedAt",
    "contextPercent",
    "contextUsedTokens",
    "contextWindowTokens",
    "contextWindowKnown",
  ])("%s のキーが無ければ落ちる", (key) => {
    const rest = Object.fromEntries(
      Object.entries(summary).filter(([name]) => name !== key),
    );

    expect(() => RunSummary.parse(rest)).toThrow();
  });

  it("知らない状態は落ちる（DDL の CHECK と同じ 6 値）", () => {
    expect(() =>
      RunSummary.parse({ ...summary, status: "sleeping" }),
    ).toThrow();
  });
});

describe("TimelineEntry", () => {
  it("3 種を受ける", () => {
    expect(
      TimelineEntry.parse({
        kind: "ask",
        at: 1,
        question: "?",
        options: [],
        answer: null,
        answeredAt: null,
        deliveredAt: null,
      }).kind,
    ).toBe("ask");

    expect(
      TimelineEntry.parse({
        kind: "event",
        at: 1,
        eventKind: "progress",
        body: "b",
        discordMessageId: null,
      }).kind,
    ).toBe("event");

    expect(
      TimelineEntry.parse({
        kind: "inbox",
        at: 1,
        body: "b",
        takenAt: null,
        takenByRunKey: null,
      }).kind,
    ).toBe("inbox");
  });

  it("知らない種別は落ちる", () => {
    expect(() => TimelineEntry.parse({ kind: "plan", at: 1 })).toThrow();
  });

  /** `events_kind_ck` と同じ 5 種だけ。 */
  it("知らない event の種別は落ちる", () => {
    expect(() =>
      TimelineEntry.parse({
        kind: "event",
        at: 1,
        eventKind: "report",
        body: "b",
        discordMessageId: null,
      }),
    ).toThrow();
  });
});
