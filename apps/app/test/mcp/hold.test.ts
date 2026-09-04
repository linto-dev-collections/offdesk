import { env } from "cloudflare:workers";
import { answerAskByButton, createDb } from "@offdesk/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  askRows,
  CHANNEL_ALPHA,
  runStatus,
  seedRun,
  seedTwoProjects,
  THREAD_ID,
} from "../db/support.ts";
import { discordOk, jsonResponse, stubOutbound } from "../support/outbound.ts";
import {
  askHumanCall,
  finalResult,
  isToolError,
  mcpCall,
  progressNotifications,
  readSse,
  toolStatusOf,
} from "./support.ts";

/*
  握り本体（要件 `F-B1` `F-B2` `F-B6`）。

  **時間で待つテストを書かない**（要件 `N-9`）。待ちの長さは
  `ASK_HOLD_MS` / `ASK_POLL_MS` / `ASK_PROGRESS_MS` / `ASK_SILENT_HOLD_MS` /
  `ASK_TOUCH_MS` で縮められるようにしてあり、`vitest.config.ts` が全テストの既定を
  数十ミリ秒にしている。

  **`readSse` を呼ぶまで pump は書き込みで詰まって止まっている**ので、
  その間に D1 へ答えを入れられる —— これが「握っている最中に人が答える」の再現。
*/

const MESSAGE_ID = "555555555555555555";

let projectId: string;

beforeEach(async () => {
  const { alpha } = await seedTwoProjects();
  projectId = alpha;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const startHold = async (input: {
  readonly runKey: string;
  readonly options?: readonly string[];
  readonly question?: string;
  readonly progressToken?: string | number;
  readonly env?: Partial<typeof env>;
}) => {
  const { response, settle } = await mcpCall(
    askHumanCall({
      runKey: input.runKey,
      question: input.question ?? "この方針で進めてよいですか",
      options: input.options ?? ["はい", "やめる"],
      ...(input.progressToken === undefined
        ? {}
        : { progressToken: input.progressToken }),
    }),
    { env: input.env },
  );

  expect(response.headers.get("content-type")).toContain("text/event-stream");
  return { response, settle };
};

/** 握っている間に「ボタンが押された」を再現する。 */
const answerLatestAsk = async (answer: string): Promise<string> => {
  const [row] = await askRows();
  if (row === undefined) throw new Error("asks に行が立っていません");

  const written = await answerAskByButton(
    createDb(env.DB),
    row.ask_id,
    answer,
    "111111111111111111",
    Date.now(),
  );
  expect(written).toBe(true);
  return row.ask_id;
};

describe("答えが入ると同じツール呼び出しの戻り値として返る", () => {
  it("answered と答えを返す", async () => {
    stubOutbound([["discord.com", discordOk({ messageId: MESSAGE_ID })]]);
    const runKey = await seedRun({ projectId });

    const { response, settle } = await startHold({ runKey });
    const askId = await answerLatestAsk("はい");

    const frames = await readSse(response);
    await settle();

    const result = finalResult(frames);
    expect(isToolError(result)).toBe(false);
    expect(toolStatusOf(result)).toEqual({
      status: "answered",
      ask_id: askId,
      answer: "はい",
    });
  });

  it("応答の id が要求の id と一致する", async () => {
    // ここがずれると、クライアントはこの応答をどのツール呼び出しにも紐付けられない。
    stubOutbound([["discord.com", discordOk({ messageId: MESSAGE_ID })]]);
    const runKey = await seedRun({ projectId });

    const { response, settle } = await mcpCall(
      askHumanCall({ runKey, question: "q", options: ["はい"], id: 42 }),
    );
    await answerLatestAsk("はい");
    const frames = await readSse(response);
    await settle();

    expect(finalResult(frames)?.id).toBe(42);
  });

  /*
    **`delivered_at` は「Claude へ書き出せた時点」で立つ**（要件 `I-3`）。
    立て忘れると次の `ask_human` が同じ答えを何度も返し、
    立てるのが早すぎると答えが宙に浮く。
  */
  it("delivered_at が立つ", async () => {
    stubOutbound([["discord.com", discordOk({ messageId: MESSAGE_ID })]]);
    const runKey = await seedRun({ projectId });

    const { response, settle } = await startHold({ runKey });
    await answerLatestAsk("はい");
    await readSse(response);
    await settle();

    const [row] = await askRows();
    expect(row?.delivered_at).not.toBeNull();
    // **answered_at より後**（`asks_delivered_ck` が逆順を禁じている）。
    expect(row?.delivered_at ?? 0).toBeGreaterThanOrEqual(
      row?.answered_at ?? 0,
    );
  });

  it("答えが入るまで delivered_at は立たない", async () => {
    stubOutbound([["discord.com", discordOk({ messageId: MESSAGE_ID })]]);
    const runKey = await seedRun({ projectId });

    const { response, settle } = await startHold({ runKey });
    // 答えを入れずに上限まで待たせる。
    await readSse(response);
    await settle();

    const [row] = await askRows();
    expect(row?.answer).toBeNull();
    expect(row?.delivered_at).toBeNull();
  });

  it("答えが入ると run が running に戻る", async () => {
    stubOutbound([["discord.com", discordOk({ messageId: MESSAGE_ID })]]);
    const runKey = await seedRun({ projectId });

    const { response, settle } = await startHold({ runKey });
    await answerLatestAsk("はい");
    await readSse(response);
    await settle();

    expect(await runStatus(runKey)).toBe("running");
  });

  /*
    **`waiting` を観測するのは「答えが入らなかった握り」の後**（状態機械の
    `running ─▶ waiting`）。

    握りに入った直後に見ても `running` のままなことがある —— `markRunWaiting` は
    ストリームを開いた後（`onOpen` の中）で走るので、`startHold` が返った時点では
    まだ実行されていない。**そこを覗くテストは順序に依存して落ちる**（実測）ので、
    観測点を「握りが終わった後」に置く。
  */
  it("答えが入らないまま終わった握りは run を waiting に残す", async () => {
    stubOutbound([["discord.com", discordOk({ messageId: MESSAGE_ID })]]);
    const runKey = await seedRun({ projectId });

    const { response, settle } = await startHold({
      runKey,
      env: { ASK_HOLD_MS: "40" },
    });
    await readSse(response);
    await settle();

    expect(await runStatus(runKey)).toBe("waiting");
  });
});

describe("上限に達したとき", () => {
  it("pending を返す（失敗ではない）", async () => {
    stubOutbound([["discord.com", discordOk({ messageId: MESSAGE_ID })]]);
    const runKey = await seedRun({ projectId });

    const { response, settle } = await startHold({
      runKey,
      progressToken: "p1",
      env: { ASK_HOLD_MS: "40" },
    });
    const frames = await readSse(response);
    await settle();

    const status = toolStatusOf(finalResult(frames));
    expect(status.status).toBe("pending");
    expect(status.ask_id).toEqual(expect.stringMatching(/^ask_[0-9a-f]{16}$/));
  });

  it("pending でも答えは D1 に残る（拾い直せる形にしておく）", async () => {
    stubOutbound([["discord.com", discordOk({ messageId: MESSAGE_ID })]]);
    const runKey = await seedRun({ projectId });

    const { response, settle } = await startHold({
      runKey,
      env: { ASK_HOLD_MS: "40" },
    });
    await readSse(response);
    await settle();

    // 行は残り、`delivered_at` は NULL のまま（P3b の `asks_undelivered_idx` が拾う）。
    const [row] = await askRows();
    expect(row?.delivered_at).toBeNull();
    expect(row?.message_id).toBe(MESSAGE_ID);
  });
});

describe("progress 通知（要件 F-B6）", () => {
  it("progressToken があれば定期的に流れる", async () => {
    stubOutbound([["discord.com", discordOk({ messageId: MESSAGE_ID })]]);
    const runKey = await seedRun({ projectId });

    const { response, settle } = await startHold({
      runKey,
      progressToken: "tok-1",
      env: { ASK_HOLD_MS: "120", ASK_PROGRESS_MS: "10", ASK_POLL_MS: "5" },
    });
    const frames = await readSse(response);
    await settle();

    const notifications = progressNotifications(frames);
    expect(notifications.length).toBeGreaterThan(0);
    expect(notifications[0]).toMatchObject({
      method: "notifications/progress",
      params: { progressToken: "tok-1", progress: 1 },
    });
  });

  it("progress は毎回増える（仕様の要求）", async () => {
    stubOutbound([["discord.com", discordOk({ messageId: MESSAGE_ID })]]);
    const runKey = await seedRun({ projectId });

    const { response, settle } = await startHold({
      runKey,
      progressToken: 7,
      env: { ASK_HOLD_MS: "150", ASK_PROGRESS_MS: "10", ASK_POLL_MS: "5" },
    });
    const frames = await readSse(response);
    await settle();

    const values = progressNotifications(frames).map(
      (n) => (n.params as { progress: number }).progress,
    );
    expect(values.length).toBeGreaterThan(1);
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(new Set(values).size).toBe(values.length);
  });

  /*
    **progress 通知は「要求で渡されたトークン」にしか紐付けられない**（仕様）。
    無いのに送ると、クライアントは紐付け先の無い通知を受け取る。
  */
  it("progressToken が無ければ 1 通も送らない", async () => {
    stubOutbound([["discord.com", discordOk({ messageId: MESSAGE_ID })]]);
    const runKey = await seedRun({ projectId });

    const { response, settle } = await startHold({
      runKey,
      env: { ASK_HOLD_MS: "60", ASK_PROGRESS_MS: "5", ASK_POLL_MS: "5" },
    });
    const frames = await readSse(response);
    await settle();

    expect(progressNotifications(frames)).toEqual([]);
  });

  it("コメント行も流れる（エッジの沈黙を作らない）", async () => {
    stubOutbound([["discord.com", discordOk({ messageId: MESSAGE_ID })]]);
    const runKey = await seedRun({ projectId });

    const { response, settle } = await startHold({
      runKey,
      env: { ASK_HOLD_MS: "60", ASK_TOUCH_MS: "10", ASK_POLL_MS: "5" },
    });
    const frames = await readSse(response);
    await settle();

    // 最初の 1 バイトが `: offdesk`。これが出るまでがエッジの勝負どころ（75 秒）。
    expect(frames.comments[0]).toBe(": offdesk");
    expect(frames.comments.length).toBeGreaterThan(1);
  });
});

describe("progressToken が無いときの沈黙の上限（要件 F-B6）", () => {
  /*
    **クライアントは無音 5 分で abort する。** 黙って落とされると `ask_id` を含まない
    エラーになるので、先に自分から降りて `pending` を返す。

    ここは**時間を待つのではなく上限を測る**: `ASK_HOLD_MS` を大きく、
    `ASK_SILENT_HOLD_MS` を小さくすると、降りたのが沈黙の上限であることが分かる
    （握りの上限まで待っていたらこのテストは 4 秒かかる）。
  */
  it("握りの上限ではなく沈黙の上限で降りる", async () => {
    stubOutbound([["discord.com", discordOk({ messageId: MESSAGE_ID })]]);
    const runKey = await seedRun({ projectId });
    const startedAt = Date.now();

    const { response, settle } = await startHold({
      runKey,
      env: {
        ASK_HOLD_MS: "4000",
        ASK_SILENT_HOLD_MS: "30",
        ASK_POLL_MS: "5",
        ASK_TOUCH_MS: "10",
      },
    });
    const frames = await readSse(response);
    await settle();

    expect(toolStatusOf(finalResult(frames)).status).toBe("pending");
    // 上限 4 秒の半分も使っていない（沈黙の上限で降りた証拠）。
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("progressToken があれば沈黙の上限に引きずられない", async () => {
    stubOutbound([["discord.com", discordOk({ messageId: MESSAGE_ID })]]);
    const runKey = await seedRun({ projectId });

    const { response, settle } = await startHold({
      runKey,
      progressToken: "tok",
      // 沈黙の上限を極端に短くしても、token があるので握りの上限が効く。
      env: {
        ASK_HOLD_MS: "80",
        ASK_SILENT_HOLD_MS: "1",
        ASK_POLL_MS: "5",
        ASK_PROGRESS_MS: "10",
      },
    });
    const frames = await readSse(response);
    await settle();

    // 沈黙の上限（1ms）で降りていたら通知は 1 通も出ない。
    expect(progressNotifications(frames).length).toBeGreaterThan(0);
  });
});

describe("Discord へ問いを出す", () => {
  it("スレッドへ素の文とボタンを出す", async () => {
    const stub = stubOutbound([
      ["discord.com", discordOk({ messageId: MESSAGE_ID })],
    ]);
    const runKey = await seedRun({ projectId, threadId: THREAD_ID });

    const { response, settle } = await startHold({
      runKey,
      question: "この方針で進めてよいですか",
      options: ["はい", "やめる"],
      env: { ASK_HOLD_MS: "40" },
    });
    await readSse(response);
    await settle();

    const [call] = stub.callsTo(`/channels/${THREAD_ID}/messages`);
    expect(call).toBeDefined();

    const payload = JSON.parse(call?.body ?? "{}") as {
      content: string;
      embeds?: unknown;
      components: readonly {
        components: readonly { custom_id: string; label: string }[];
      }[];
    };

    // **枠を付けない**（要件 `F-B5`。これは Claude 本人の発言）。
    expect(payload.content).toBe("この方針で進めてよいですか");
    expect(payload.embeds).toBeUndefined();

    const [row] = await askRows();
    expect(payload.components[0]?.components.map((c) => c.label)).toEqual([
      "はい",
      "やめる",
    ]);
    expect(payload.components[0]?.components.map((c) => c.custom_id)).toEqual([
      `ans:${row?.ask_id}:0`,
      `ans:${row?.ask_id}:1`,
    ]);
  });

  it("スレッドが無ければ親チャンネルへ出す", async () => {
    const stub = stubOutbound([
      ["discord.com", discordOk({ messageId: MESSAGE_ID })],
    ]);
    const runKey = await seedRun({ projectId, threadId: null });

    const { response, settle } = await startHold({
      runKey,
      env: { ASK_HOLD_MS: "40" },
    });
    await readSse(response);
    await settle();

    expect(stub.callsTo(`/channels/${CHANNEL_ALPHA}/messages`)).toHaveLength(1);
  });

  it("message_id を asks に入れる", async () => {
    stubOutbound([["discord.com", discordOk({ messageId: MESSAGE_ID })]]);
    const runKey = await seedRun({ projectId });

    const { response, settle } = await startHold({
      runKey,
      env: { ASK_HOLD_MS: "40" },
    });
    await readSse(response);
    await settle();

    const [row] = await askRows();
    expect(row?.message_id).toBe(MESSAGE_ID);
  });

  it("1 回の握りで 1 通だけ出す", async () => {
    const stub = stubOutbound([
      ["discord.com", discordOk({ messageId: MESSAGE_ID })],
    ]);
    const runKey = await seedRun({ projectId });

    const { response, settle } = await startHold({
      runKey,
      env: { ASK_HOLD_MS: "60", ASK_TOUCH_MS: "10", ASK_POLL_MS: "5" },
    });
    await readSse(response);
    await settle();

    // ハートビートのたびに出し直していたら、ここが 1 より大きくなる。
    expect(stub.callsTo("/messages")).toHaveLength(1);
  });

  /*
    **出せていないなら「待て」と言っても永久に答えは来ない**（要件 `N-7`）。
    すぐ理由を返して Claude に判断させる。
  */
  it("Discord に出せなかったら握らずに理由を返す", async () => {
    stubOutbound([["discord.com", () => jsonResponse({ message: "no" }, 403)]]);
    const runKey = await seedRun({ projectId });

    const { response, settle } = await startHold({ runKey });
    const frames = await readSse(response);
    await settle();

    const result = finalResult(frames);
    expect(isToolError(result)).toBe(true);
    expect(toolStatusOf(result).status).toBe("not_delivered");
    expect(String(toolStatusOf(result).next)).toContain("届いていない");
  });

  it("出せなかったときも asks の行は残る（何を試みたかを消さない）", async () => {
    stubOutbound([["discord.com", () => jsonResponse({ message: "no" }, 403)]]);
    const runKey = await seedRun({ projectId });

    const { response, settle } = await startHold({ runKey });
    await readSse(response);
    await settle();

    const [row] = await askRows();
    expect(row?.message_id).toBeNull();
    expect(row?.answer).toBeNull();
  });
});

describe("握りのハートビート（要件 F-C5）", () => {
  it("握っている間 held_at が更新される", async () => {
    stubOutbound([["discord.com", discordOk({ messageId: MESSAGE_ID })]]);
    const startedAt = Date.now() - 60_000;
    const runKey = await seedRun({ projectId, heldAt: startedAt });

    const { response, settle } = await startHold({
      runKey,
      env: { ASK_HOLD_MS: "60", ASK_TOUCH_MS: "10", ASK_POLL_MS: "5" },
    });
    await readSse(response);
    await settle();

    const { runHeldAt } = await import("../db/support.ts");
    expect(await runHeldAt(runKey)).toBeGreaterThan(startedAt);
  });
});

describe("ストリームを開くのが Discord への投稿より先", () => {
  /*
    **エッジは「最初の 1 バイトが返らない」まま 75 秒で 502 を返す。**
    外向きの HTTP を先に叩くと、その待ち時間がまるごとその時間になる。

    観測できる形にする: 投稿が来た**時点でストリームは既に開いている** ——
    Discord のスタブが呼ばれるまでに `: offdesk` が流れていることを見る。
  */
  it("Discord が呼ばれる前に最初の 1 バイトが出ている", async () => {
    let commentSeenWhenPosted: string | null = null;
    const seen: string[] = [];

    const runKey = await seedRun({ projectId });
    stubOutbound([
      [
        "discord.com",
        () => {
          commentSeenWhenPosted = seen[0] ?? null;
          return jsonResponse({ id: MESSAGE_ID });
        },
      ],
    ]);

    const { response, settle } = await startHold({
      runKey,
      env: { ASK_HOLD_MS: "40" },
    });

    // 1 バイト目だけを先に読む（pump は投稿の前にこれを書いている）。
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    const first = await reader?.read();
    seen.push(decoder.decode(first?.value).trim());

    // 残りを読み切って握りを終わらせる。
    for (;;) {
      const chunk = await reader?.read();
      if (chunk === undefined || chunk.done) break;
    }
    await settle();

    expect(seen[0]).toBe(": offdesk");
    expect(commentSeenWhenPosted).toBe(": offdesk");
  });
});

describe("握らせない run では Discord に問いを置かない", () => {
  it("終端の run では 1 通も出ない", async () => {
    const stub = stubOutbound([
      ["discord.com", discordOk({ messageId: MESSAGE_ID })],
    ]);
    const runKey = await seedRun({ projectId, status: "done" });

    const { response, settle } = await mcpCall(
      askHumanCall({ runKey, question: "q", options: ["はい"] }),
    );
    await response.json();
    await settle();

    expect(stub.calls).toEqual([]);
  });
});
