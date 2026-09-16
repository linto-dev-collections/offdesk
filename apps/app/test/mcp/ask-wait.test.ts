import { env } from "cloudflare:workers";
import { answerAskByButton, createDb, insertAsk } from "@offdesk/db";
import { RESEND_QUESTION } from "@offdesk/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  askRows,
  db,
  eventRows,
  runStatus,
  seedRun,
  seedTwoProjects,
} from "../db/support.ts";
import {
  discordOk,
  type OutboundStub,
  stubOutbound,
} from "../support/outbound.ts";
import {
  askHumanCall,
  finalResult,
  isToolError,
  mcpCall,
  readSse,
  toolStatusOf,
  toolText,
} from "./support.ts";

/*
  `ask_wait`（計画 P3b §3-3）。**`ask_id` が手元にあるときの近道。**

  やることは握り直しと同じで、違うのは「どの ask を握るか」の決め方だけ。
  ここで固めたいのは 2 つ:

    1. **配達済みでもう一度呼ばれても止まらない**（冪等）。Claude が同じ `ask_id` で
       2 回呼ぶことは正常にありうる（応答を受け取る前に落ちた場合）
    2. **`ask_human` が `pending` で降りたときの出口になっている**（脅威 16 の分岐）
*/

const MESSAGE_ID = "555555555555555555";
const ASK_ID = "ask_1111111111111111";

let projectId: string;
let stub: OutboundStub;

beforeEach(async () => {
  const { alpha } = await seedTwoProjects();
  projectId = alpha;
  stub = stubOutbound([["discord.com", discordOk({ messageId: MESSAGE_ID })]]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const seedAsk = async (input: {
  readonly status?: string;
  readonly heldAt?: number | null;
  readonly answer?: string;
  readonly delivered?: boolean;
}): Promise<string> => {
  const runKey = await seedRun({
    projectId,
    status: input.status ?? "waiting",
    heldAt: input.heldAt ?? Date.now() - 10 * 60_000,
  });

  await insertAsk(
    db(),
    {
      askId: ASK_ID,
      runKey,
      question: "どちらにしますか",
      options: ["A", "B"],
    },
    Date.now() - 60_000,
  );

  if (input.answer !== undefined) {
    await answerAskByButton(
      createDb(env.DB),
      ASK_ID,
      input.answer,
      "111111111111111111",
      Date.now(),
    );
  }
  if (input.delivered === true) {
    await env.DB.prepare("UPDATE asks SET delivered_at = ? WHERE ask_id = ?")
      .bind(Date.now(), ASK_ID)
      .run();
  }

  return runKey;
};

const waitCall = (askId: string) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "ask_wait", arguments: { ask_id: askId } },
});

const askWaitJson = async (askId: string) => {
  const { response, settle } = await mcpCall(waitCall(askId));
  expect(response.headers.get("content-type")).toContain("application/json");
  const body = (await response.json()) as Record<string, unknown>;
  await settle();
  return body;
};

describe("答えが入っているとき", () => {
  it("その答えを返して delivered_at を立てる", async () => {
    await seedAsk({ answer: "A" });

    const body = await askWaitJson(ASK_ID);

    expect(toolStatusOf(body)).toMatchObject({
      status: "answered",
      ask_id: ASK_ID,
      answer: "A",
    });
    expect((await askRows())[0]?.delivered_at).not.toBeNull();
  });

  it("Discord には何も出さない", async () => {
    await seedAsk({ answer: "A" });

    await askWaitJson(ASK_ID);

    expect(stub.calls).toEqual([]);
  });

  it("run が running に戻る", async () => {
    const runKey = await seedAsk({ answer: "A" });

    await askWaitJson(ASK_ID);

    expect(await runStatus(runKey)).toBe("running");
  });
});

describe("配達済みでもう一度呼ばれたとき（冪等）", () => {
  /*
    **エラーを返すと会話が止まる。** Claude が同じ `ask_id` で 2 回呼ぶことは
    正常にありうる（応答を受け取る前に落ちた場合）。
  */
  it("同じ答えをもう一度返す", async () => {
    await seedAsk({ answer: "A", delivered: true });

    const body = await askWaitJson(ASK_ID);

    expect(isToolError(body)).toBe(false);
    expect(toolStatusOf(body)).toMatchObject({
      status: "answered",
      ask_id: ASK_ID,
      answer: "A",
    });
  });

  /** **`delivered_at` は「最初に渡せた時刻」。** 上書きすると調査の手掛かりが消える。 */
  it("delivered_at を上書きしない", async () => {
    await seedAsk({ answer: "A", delivered: true });
    const before = (await askRows())[0]?.delivered_at;

    await askWaitJson(ASK_ID);

    expect((await askRows())[0]?.delivered_at).toBe(before);
  });

  it("何度呼んでも握らない", async () => {
    await seedAsk({ answer: "A", delivered: true });

    for (let i = 0; i < 3; i += 1) {
      const body = await askWaitJson(ASK_ID);
      expect(toolStatusOf(body).answer).toBe("A");
    }
  });
});

describe("まだ未回答のとき", () => {
  it("同じ問いを握り直す（Discord に出し直さない）", async () => {
    await seedAsk({});

    const { response, settle } = await mcpCall(waitCall(ASK_ID), {
      env: { ASK_HOLD_MS: "40" },
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const frames = await readSse(response);
    await settle();

    expect(toolStatusOf(finalResult(frames))).toMatchObject({
      status: "pending",
      ask_id: ASK_ID,
    });
    expect(stub.calls).toEqual([]);
  });

  it("握っている間に答えが入れば返る", async () => {
    await seedAsk({});

    const { response, settle } = await mcpCall(waitCall(ASK_ID));
    await answerAskByButton(
      createDb(env.DB),
      ASK_ID,
      "B",
      "111111111111111111",
      Date.now(),
    );
    const frames = await readSse(response);
    await settle();

    expect(toolStatusOf(finalResult(frames)).answer).toBe("B");
  });

  /*
    **`ask_wait` は `held_at` の検査を持たない**（`ask_human` にはある）。
    こちらは「この問いを待ち直す」という明示の指示で、`ask_human` が
    `pending` で降りた Claude が使う出口そのもの —— ここで同じ検査をすると出口が塞がる。
  */
  it("握りが生きていても握り直せる（pending の出口を塞がない）", async () => {
    await seedAsk({ heldAt: Date.now() });

    const { response, settle } = await mcpCall(waitCall(ASK_ID), {
      env: { ASK_HOLD_MS: "40" },
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    await readSse(response);
    await settle();
  });
});

describe("握れない形", () => {
  it("知らない ask_id はエラー", async () => {
    await seedAsk({});

    const body = await askWaitJson("ask_ffffffffffffffff");

    expect(isToolError(body)).toBe(true);
    expect(toolText(body)).toContain("見つかりません");
  });

  it("ask_id が空でもエラー", async () => {
    await seedAsk({});

    expect(isToolError(await askWaitJson(""))).toBe(true);
  });

  it.each(["done", "failed", "abandoned"])(
    "run が %s なら握らない",
    async (status) => {
      /*
        **終端の run の問いを永久に握り直さない。** ここが無いと
        `ask_wait` → 15 分握る → `pending` → `ask_wait` … を繰り返し、
        15 分ごとに全文脈を積んだリクエストが飛ぶ（「待ちにトークンを使わせない」を
        いちばん静かに裏切る経路）。
      */
      await seedAsk({ status });

      const body = await askWaitJson(ASK_ID);

      expect(isToolError(body)).toBe(true);
      expect(toolStatusOf(body).status).toBe("closed");
    },
  );
});

describe("ask_human の pending から ask_wait へ繋がる（脅威 16 の出口）", () => {
  /*
    握りが落ちた直後は `held_at` がまだ新しいので、`ask_human` の呼び直しは
    脅威 16 の検査に当たって `pending` になる。**そのとき `ask_id` を返している**
    ので、Claude はそのまま `ask_wait` で拾い直せる ——
    これが無いと、落ちた直後の呼び直しが行き止まりになる。
  */
  it("pending に ask_id が入り、その id で握り直せる", async () => {
    const runKey = await seedRun({
      projectId,
      status: "waiting",
      heldAt: Date.now(),
    });
    await insertAsk(
      db(),
      { askId: ASK_ID, runKey, question: "どちらに", options: ["A", "B"] },
      Date.now(),
    );

    const { response, settle } = await mcpCall(
      askHumanCall({ runKey, question: RESEND_QUESTION }),
    );
    const body = (await response.json()) as Record<string, unknown>;
    await settle();

    const status = toolStatusOf(body);
    expect(status.status).toBe("pending");
    expect(status.ask_id).toBe(ASK_ID);

    // 返ってきた id でそのまま待ち直せる。
    const { response: held, settle: settleHeld } = await mcpCall(
      waitCall(String(status.ask_id)),
      { env: { ASK_HOLD_MS: "40" } },
    );
    expect(held.headers.get("content-type")).toContain("text/event-stream");
    await readSse(held);
    await settleHeld();

    expect(stub.calls).toEqual([]);
  });
});

/*
  **待ちの上限**（`ASK_ABANDON_MS`。2026-09-16 に足した）。

  `ASK_HOLD_MS` は 1 回の握りの長さで、上限に達したら `pending` を返して
  `ask_wait` に引き継ぐ —— **あれだけでは待ちは終わらない。** 依頼者が
  答えないまま放っておくと、セッションは 15 分ごとに呼び直して無期限に生き残る。
  沈黙の掃除にも掛からない（あれが見る `held_at` は握りが 15 秒ごとに書き直す）。
*/
describe("答えないまま上限に達したとき", () => {
  /** 問いは 60 秒前に出ているので、上限を 10 ミリ秒にすれば必ず過ぎている。 */
  const OVER = { ASK_ABANDON_MS: "10" } as const;

  it("closed を返して、ストリームを開かない", async () => {
    const runKey = await seedAsk({});

    const { response, settle } = await mcpCall(waitCall(ASK_ID), { env: OVER });
    // **開く前に分かっているものは開かない**（SSE ではなく JSON で返る）。
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as Record<string, unknown>;
    await settle();

    expect(toolStatusOf(body)).toMatchObject({
      status: "closed",
      ask_id: ASK_ID,
    });
    expect(isToolError(body)).toBe(true);
    expect(await runStatus(runKey)).toBe("done");
  });

  /** **無言で捨てない**（要件 `N-7`）。run 詳細の時系列に 1 行並ぶ。 */
  it("events に 1 行残る", async () => {
    const runKey = await seedAsk({});

    const { settle } = await mcpCall(waitCall(ASK_ID), { env: OVER });
    await settle();

    const events = (await eventRows()).filter((row) => row.run_key === runKey);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("done");
    expect(events[0]?.body).toContain("24 時間");
  });

  /*
    **畳んだあとは `gateRun` が門になる。** もう一度呼ばれても
    `closed` のままで、`events` が 2 行に増えない。
  */
  it("もう一度呼んでも closed のまま（記録は増えない）", async () => {
    const runKey = await seedAsk({});

    await (await mcpCall(waitCall(ASK_ID), { env: OVER })).settle();
    const second = await mcpCall(waitCall(ASK_ID), { env: OVER });
    const body = (await second.response.json()) as Record<string, unknown>;
    await second.settle();

    expect(toolStatusOf(body).status).toBe("closed");
    expect(
      (await eventRows()).filter((row) => row.run_key === runKey),
    ).toHaveLength(1);
  });

  /** **上限の手前なら今までどおり握る。** 上限を入れて待てなくしていない。 */
  it("上限の手前なら握る", async () => {
    await seedAsk({});

    const { response, settle } = await mcpCall(waitCall(ASK_ID), {
      env: { ASK_HOLD_MS: "40", ASK_ABANDON_MS: "600000" },
    });
    const frames = await readSse(response);
    await settle();

    expect(toolStatusOf(finalResult(frames)).status).toBe("pending");
  });

  /*
    **`ask_human` の拾い直しも同じ門を通る。** `ask_wait` だけに置くと、
    `ask_id` を失ったセッションが `(再送)` で無限に待ち直せてしまう。
  */
  it("ask_human の拾い直しでも closed", async () => {
    const runKey = await seedAsk({});

    const { response, settle } = await mcpCall(
      askHumanCall({ runKey, question: RESEND_QUESTION }),
      { env: OVER },
    );
    const body = (await response.json()) as Record<string, unknown>;
    await settle();

    expect(toolStatusOf(body).status).toBe("closed");
    expect(await runStatus(runKey)).toBe("done");
    // **質問を出し直さない。**
    expect(stub.callsTo("/messages")).toHaveLength(0);
  });
});
