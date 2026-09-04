import { env } from "cloudflare:workers";
import { answerAskByButton, createDb, insertAsk } from "@offdesk/db";
import { RESEND_QUESTION } from "@offdesk/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  askRows,
  db,
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
  nudge,
  readSse,
  toolStatusOf,
  waitUntilTrue,
} from "./support.ts";

/*
  **握りが落ちても失わせない**（要件 `F-B3`・計画 P3b §5）。

  壁を全部外しても transport は落ちる。落ちたとき Claude に届くのは **`ask_id` を
  含まない**エラーなので、Claude にできるのは `ask_human` を呼び直すことだけ。
  素通りさせると 2 つの事故になる:

    1. Discord に同じ質問が 2 通出る
    2. 切れている間に人が答えていた場合、**その答えが宙に浮いて永久に届かない**

  **「投稿が 0 回」を数えるのがこのファイルの中心。** 2 番目は kanata で実際に
  起きている（2026-08-29 に質問 1 つが失われた）。
*/

const MESSAGE_ID = "555555555555555555";
const OLD_ASK = "ask_1111111111111111";
const NEW_ASK = "ask_2222222222222222";

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

/**
 * 「握りが落ちた後」の状態を作る。
 *
 * **`held_at` は古くしておく** —— 新しいままだと脅威 16 の検査（2 本目を握らない）に
 * 当たって `pending` になり、拾い直しの経路まで届かない。
 * その分岐そのものは下の「本当に接続を切ってから呼び直す」と `ask-wait.test.ts` が見る。
 */
const seedDroppedHold = async (input: {
  readonly askId?: string;
  readonly answer?: string;
  readonly createdAt?: number;
}): Promise<string> => {
  const runKey = await seedRun({
    projectId,
    status: "waiting",
    heldAt: Date.now() - 10 * 60_000,
  });

  const askId = input.askId ?? OLD_ASK;
  await insertAsk(
    db(),
    {
      askId,
      runKey,
      question: "どちらの方針で進めますか",
      options: ["A で進める", "B で進める"],
    },
    input.createdAt ?? Date.now() - 60_000,
  );
  await env.DB.prepare("UPDATE asks SET message_id = ? WHERE ask_id = ?")
    .bind(MESSAGE_ID, askId)
    .run();

  if (input.answer !== undefined) {
    await answerAskByButton(
      createDb(env.DB),
      askId,
      input.answer,
      "111111111111111111",
      Date.now(),
    );
  }

  return runKey;
};

const resend = (runKey: string) =>
  mcpCall(askHumanCall({ runKey, question: RESEND_QUESTION }));

describe("未配達 ＋ 答えが入っている", () => {
  it("その答えを返す（握らない）", async () => {
    const runKey = await seedDroppedHold({ answer: "A で進める" });

    const { response, settle } = await resend(runKey);
    // **握らない。** 答えは既にあるので、ストリームを開く理由がない。
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as Record<string, unknown>;
    await settle();

    expect(isToolError(body)).toBe(false);
    expect(toolStatusOf(body)).toMatchObject({
      status: "answered",
      ask_id: OLD_ASK,
      answer: "A で進める",
    });
  });

  it("Discord に質問を出し直さない（投稿 0 回）", async () => {
    const runKey = await seedDroppedHold({ answer: "A で進める" });

    const { settle } = await resend(runKey);
    await settle();

    expect(stub.calls).toEqual([]);
  });

  /*
    **ここが `I-3` の要。** 渡せた瞬間に `delivered_at` を立てないと、
    次の `ask_human` が同じ答えを何度も返す。
  */
  it("delivered_at が立つ", async () => {
    const runKey = await seedDroppedHold({ answer: "A で進める" });

    const { settle } = await resend(runKey);
    await settle();

    const [row] = await askRows();
    expect(row?.delivered_at).not.toBeNull();
  });

  it("2 回目の呼び直しでは同じ答えを返さない（配達済みは拾わない）", async () => {
    const runKey = await seedDroppedHold({ answer: "A で進める" });

    const { settle } = await resend(runKey);
    await settle();

    // 配達済みになったので、次は「拾うものが無い」に落ちる。
    const { response, settle: settle2 } = await resend(runKey);
    const body = (await response.json()) as Record<string, unknown>;
    await settle2();

    expect(isToolError(body)).toBe(true);
    // 昔の答えが蘇らないこと。
    expect(toolStatusOf(body).answer).toBeUndefined();
  });

  it("run が running に戻る", async () => {
    const runKey = await seedDroppedHold({ answer: "A で進める" });

    const { settle } = await resend(runKey);
    await settle();

    expect(await runStatus(runKey)).toBe("running");
  });

  it("前後に空白のある (再送) でも同じ扱い", async () => {
    const runKey = await seedDroppedHold({ answer: "A で進める" });

    const { response, settle } = await mcpCall(
      askHumanCall({ runKey, question: `  ${RESEND_QUESTION}  ` }),
    );
    const body = (await response.json()) as Record<string, unknown>;
    await settle();

    expect(toolStatusOf(body).status).toBe("answered");
  });

  /*
    **本物の問いで呼び直されても拾い直す。** Claude が `(再送)` と書かずに
    別の質問文で呼び直すことは普通に起きる —— そのときも**新しい問いを立てない**
    （立てると Discord に 2 通出て、宙に浮いた答えがそのまま消える）。
  */
  it("(再送) 以外の question で呼び直されても拾い直す", async () => {
    const runKey = await seedDroppedHold({ answer: "A で進める" });

    const { response, settle } = await mcpCall(
      askHumanCall({
        runKey,
        question: "改めて伺います。どちらにしますか",
        options: ["A", "B"],
      }),
    );
    const body = (await response.json()) as Record<string, unknown>;
    await settle();

    expect(toolStatusOf(body).answer).toBe("A で進める");
    expect(stub.calls).toEqual([]);
    expect(await askRows()).toHaveLength(1);
  });
});

describe("未配達 ＋ まだ未回答", () => {
  it("同じ問いを握り直す", async () => {
    const runKey = await seedDroppedHold({});

    const { response, settle } = await mcpCall(
      askHumanCall({ runKey, question: RESEND_QUESTION }),
      { env: { ASK_HOLD_MS: "40" } },
    );
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const frames = await readSse(response);
    await settle();

    // 上限まで握ってから pending。**同じ ask_id を握っている。**
    const status = toolStatusOf(finalResult(frames));
    expect(status.status).toBe("pending");
    expect(status.ask_id).toBe(OLD_ASK);
  });

  it("Discord に 2 通目を出さない（投稿 0 回）", async () => {
    const runKey = await seedDroppedHold({});

    const { response, settle } = await mcpCall(
      askHumanCall({ runKey, question: RESEND_QUESTION }),
      { env: { ASK_HOLD_MS: "40" } },
    );
    await readSse(response);
    await settle();

    expect(stub.calls).toEqual([]);
    expect(await askRows()).toHaveLength(1);
  });

  it("握り直している間に答えが入れば、それを返す", async () => {
    const runKey = await seedDroppedHold({});

    const { response, settle } = await mcpCall(
      askHumanCall({ runKey, question: RESEND_QUESTION }),
    );
    await answerAskByButton(
      createDb(env.DB),
      OLD_ASK,
      "B で進める",
      "111111111111111111",
      Date.now(),
    );
    const frames = await readSse(response);
    await settle();

    expect(toolStatusOf(finalResult(frames))).toMatchObject({
      status: "answered",
      ask_id: OLD_ASK,
      answer: "B で進める",
    });
    expect(stub.calls).toEqual([]);
  });
});

describe("返せていない問いが無い", () => {
  it("ふつうに新しい問いを立てる（投稿 1 回）", async () => {
    const runKey = await seedRun({ projectId });

    const { response, settle } = await mcpCall(
      askHumanCall({ runKey, question: "どうしますか", options: ["はい"] }),
      { env: { ASK_HOLD_MS: "40" } },
    );
    await readSse(response);
    await settle();

    expect(stub.callsTo("/messages")).toHaveLength(1);
    expect(await askRows()).toHaveLength(1);
  });

  /*
    **配達済みの問いは「返せていない問い」ではない。** ここが緩いと、
    会話が先へ進んだ後に昔の問いを握り直してしまう。
  */
  it("配達済みの問いしか無ければ新しい問いを立てる", async () => {
    const runKey = await seedDroppedHold({ answer: "A で進める" });
    await env.DB.prepare("UPDATE asks SET delivered_at = ? WHERE ask_id = ?")
      .bind(Date.now(), OLD_ASK)
      .run();

    const { response, settle } = await mcpCall(
      askHumanCall({
        runKey,
        question: "次はどうしますか",
        options: ["続ける"],
      }),
      { env: { ASK_HOLD_MS: "40" } },
    );
    await readSse(response);
    await settle();

    expect(stub.callsTo("/messages")).toHaveLength(1);
    expect(await askRows()).toHaveLength(2);
  });
});

describe("拾うのはいちばん新しい未配達の問い", () => {
  /*
    **古い方を拾うと、会話が先へ進んだ後に昔の答えが蘇る**（要件 `F-B3`）。
    `created_at` を明示して並びを決める —— 同じミリ秒だと順序が決まらない。
  */
  it("未配達が 2 つあるとき、新しい方を拾う", async () => {
    const runKey = await seedDroppedHold({
      askId: OLD_ASK,
      createdAt: 1_788_400_000_000,
    });
    await insertAsk(
      db(),
      {
        askId: NEW_ASK,
        runKey,
        question: "そのあとはどうしますか",
        options: ["C", "D"],
      },
      1_788_400_060_000,
    );
    await answerAskByButton(
      createDb(env.DB),
      NEW_ASK,
      "C",
      "111111111111111111",
      Date.now(),
    );

    const { response, settle } = await resend(runKey);
    const body = (await response.json()) as Record<string, unknown>;
    await settle();

    expect(toolStatusOf(body)).toMatchObject({
      status: "answered",
      ask_id: NEW_ASK,
      answer: "C",
    });
  });

  it("古い方に答えが入っていても、新しい方を握り直す", async () => {
    // 新しい方が未回答なら、そちらを待つ。**古い答えを先に返さない。**
    const runKey = await seedDroppedHold({
      askId: OLD_ASK,
      answer: "A で進める",
      createdAt: 1_788_400_000_000,
    });
    await insertAsk(
      db(),
      { askId: NEW_ASK, runKey, question: "そのあとは", options: ["C"] },
      1_788_400_060_000,
    );

    const { response, settle } = await mcpCall(
      askHumanCall({ runKey, question: RESEND_QUESTION }),
      { env: { ASK_HOLD_MS: "40" } },
    );
    const frames = await readSse(response);
    await settle();

    expect(toolStatusOf(finalResult(frames)).ask_id).toBe(NEW_ASK);
  });
});

describe("本当に接続を切ってから呼び直す", () => {
  /*
    **完了条件の「握りを人為的に切っても会話が続く」を機械で踏む。**

    `response.body.cancel()` は**クライアントが切ったのと同じ**（pump の次の書き込みが
    落ちて、`hold.ts` の catch に入る）。実物のデプロイや接続断でも同じ経路を通る。

    切った直後は `held_at` がまだ新しいので、呼び直しは脅威 16 の検査に当たって
    `pending` になる —— **そこに `ask_id` が入っているから会話が続く。**
    これが無いと、落ちた直後の呼び直しが行き止まりになる。
  */
  it("切った後の呼び直しで会話が続き、Discord への投稿は 1 回のまま", async () => {
    const runKey = await seedRun({ projectId });

    // 1 本目: 新しい問いを立てて握る。
    const { response, settle } = await mcpCall(
      askHumanCall({
        runKey,
        question: "どちらにしますか",
        options: ["A", "B"],
      }),
    );
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    /*
      **読むまで pump は 1 歩も進まない。** `TransformStream` の readable 側の
      highWaterMark は 0 なので、**最初の `write` すら読み手が来るまで解決しない**
      （実測でここに詰まった）。

      これは設計として正しい —— 聞いていないクライアントのために Discord へ
      投稿したりはしない。テスト側は「1 個読んで pump を歩かせる → 投稿が済むのを
      条件で待つ → 切る」の順に書く必要がある。
    */
    await nudge(response);
    await waitUntilTrue(
      async () => (await askRows())[0]?.message_id !== null,
      "問いが Discord に出る",
    );
    const [created] = await askRows();
    expect(created?.message_id).toBe(MESSAGE_ID);

    // **接続を切る。** ここから先、1 本目の握りは誰にも届かない。
    await response.body?.cancel();
    await settle();

    // 2 本目: `ask_id` が手元に無いので `(再送)` で呼び直す。
    const { response: retried, settle: settleRetry } = await resend(runKey);
    const body = (await retried.json()) as Record<string, unknown>;
    await settleRetry();

    const status = toolStatusOf(body);
    expect(status.status).toBe("pending");
    expect(status.ask_id).toBe(created?.ask_id);

    // 3 本目: 返ってきた id で握り直す。**ここで答えが入れば返る。**
    const { response: held, settle: settleHeld } = await mcpCall({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "ask_wait", arguments: { ask_id: status.ask_id } },
    });
    await answerAskByButton(
      createDb(env.DB),
      String(created?.ask_id),
      "A",
      "111111111111111111",
      Date.now(),
    );
    const frames = await readSse(held);
    await settleHeld();

    expect(toolStatusOf(finalResult(frames))).toMatchObject({
      status: "answered",
      answer: "A",
    });

    // **問いは 1 通しか出ていない**（3 往復したのに）。
    expect(stub.callsTo("/messages")).toHaveLength(1);
    expect(await askRows()).toHaveLength(1);
  });

  it("切った後、held_at が古くなっていれば ask_human だけで握り直せる", async () => {
    const runKey = await seedRun({ projectId });

    const { response, settle } = await mcpCall(
      askHumanCall({
        runKey,
        question: "どちらにしますか",
        options: ["A", "B"],
      }),
    );
    // 1 個読んで pump を歩かせてから、投稿が済むのを条件で待つ（上の why を参照）。
    await nudge(response);
    await waitUntilTrue(
      async () => (await askRows())[0]?.message_id !== null,
      "問いが Discord に出る",
    );
    await response.body?.cancel();
    await settle();

    // 握りが死んで窓を過ぎた状態にする（時間で待たずに列を直接古くする）。
    await env.DB.prepare("UPDATE runs SET held_at = ? WHERE run_key = ?")
      .bind(Date.now() - 10 * 60_000, runKey)
      .run();

    const { response: retried, settle: settleRetry } = await mcpCall(
      askHumanCall({ runKey, question: RESEND_QUESTION }),
      { env: { ASK_HOLD_MS: "40" } },
    );
    expect(retried.headers.get("content-type")).toContain("text/event-stream");
    const frames = await readSse(retried);
    await settleRetry();

    const [row] = await askRows();
    expect(toolStatusOf(finalResult(frames)).ask_id).toBe(row?.ask_id);
    expect(stub.callsTo("/messages")).toHaveLength(1);
  });
});
