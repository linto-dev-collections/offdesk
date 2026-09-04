import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyInbound } from "../../src/worker/discord/inbound.ts";
import { MARK_HANDED, MARK_SEEN } from "../../src/worker/discord/marks.ts";
import {
  askRows,
  runStatus,
  seedRun,
  seedTwoProjects,
  THREAD_ID,
} from "../db/support.ts";
import { OWNER_ID } from "../discord/support.ts";
import {
  discordOk,
  type OutboundStub,
  stubOutbound,
} from "../support/outbound.ts";
import {
  askHumanCall,
  finalResult,
  mcpCall,
  nudge,
  readSse,
  toolStatusOf,
  waitUntilTrue,
} from "./support.ts";

/*
  **スレッドに素で書いた文が Claude へ届き、👀 → ✅ に変わる**（P4 の完了条件）。

  握りと素の文の経路を**通しで**踏む唯一のテスト。片方だけを見ていると
  要件 `I-3` の「印と台帳を同じ場所で進める」が破れても気付けない ——
  `applyInbound` は答えを書くだけ（👀）で、✅ に変えるのは
  `delivered_at` を立てる握りの側だから。

  ```txt
  ask_human（握る）→ 問いを Discord へ → 素の文が届く（answer ＋ 👀）
    → 握りが答えを見つける → delivered_at ＋ ✅ → ask_human が返る
  ```
*/

const HUMAN_MESSAGE_ID = "777777777777777777";

let projectId: string;
let stub: OutboundStub;

beforeEach(async () => {
  const { alpha } = await seedTwoProjects();
  projectId = alpha;
  stub = stubOutbound([
    ["discord.com", discordOk({ messageId: "555555555555555555" })],
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const reactionCalls = (emoji: string) =>
  stub.callsTo(`/reactions/${encodeURIComponent(emoji)}/@me`);

describe("問いを握っている間に素で書いたとき", () => {
  it("その文が答えとして返り、印が ✅ に変わる", async () => {
    const runKey = await seedRun({ projectId, status: "running" });

    const { response, settle } = await mcpCall(
      askHumanCall({
        runKey,
        question: "どちらにしますか",
        options: ["A", "B"],
      }),
    );
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    /*
      **1 個読んで pump を歩かせる**（P3b §9-3）。読まずに次へ進むと、
      問いが Discord へ出る前に答えを書くことになる。
    */
    await nudge(response);
    await waitUntilTrue(
      async () => (await askRows())[0]?.message_id !== null,
      "問いが Discord に出る",
    );

    const outcome = await applyInbound(env, {
      messageId: HUMAN_MESSAGE_ID,
      channelId: THREAD_ID,
      authorId: OWNER_ID,
      authorIsBot: false,
      content: "A で進めて",
    });
    expect(outcome.decision).toBe("answer");

    const frames = await readSse(response);
    await settle();

    // **Claude へ届いた。**
    expect(toolStatusOf(finalResult(frames))).toMatchObject({
      status: "answered",
      answer: "A で進めて",
    });

    // **印が ✅ に変わった**（`delivered_at` を立てるのと同じ場所）。
    const [row] = await askRows();
    expect(row?.delivered_at).not.toBeNull();
    expect(row?.answer_message_id).toBe(HUMAN_MESSAGE_ID);

    const handed = reactionCalls(MARK_HANDED).filter(
      (call) =>
        call.method === "PUT" && call.url.includes(`/${HUMAN_MESSAGE_ID}/`),
    );
    expect(handed).toHaveLength(1);
    const unseen = reactionCalls(MARK_SEEN).filter(
      (call) =>
        call.method === "DELETE" && call.url.includes(`/${HUMAN_MESSAGE_ID}/`),
    );
    expect(unseen).toHaveLength(1);

    expect(await runStatus(runKey)).toBe("running");
  });

  /*
    **質問は 1 通だけ。** 答えは同じスレッドの別のメッセージなので、
    問いを出し直す理由が無い（要件 `F-B3`）。
  */
  it("Discord に問いが 1 通しか出ない", async () => {
    const runKey = await seedRun({ projectId, status: "running" });

    const { response, settle } = await mcpCall(
      askHumanCall({ runKey, question: "どちら", options: ["A", "B"] }),
    );
    await nudge(response);
    await waitUntilTrue(
      async () => (await askRows())[0]?.message_id !== null,
      "問いが Discord に出る",
    );

    await applyInbound(env, {
      messageId: HUMAN_MESSAGE_ID,
      channelId: THREAD_ID,
      authorId: OWNER_ID,
      authorIsBot: false,
      content: "A で",
    });
    await readSse(response);
    await settle();

    const posts = stub
      .callsTo(`/channels/${THREAD_ID}/messages`)
      .filter((call) => call.method === "POST");
    expect(posts).toHaveLength(1);
  });
});

describe("握りが落ちている間に素で書いたとき", () => {
  /*
    **切れている間に届いた答えが宙に浮かない**（要件 `I-3`）。
    P3b の `(再送)` で拾い直す経路に、素の文の答えも乗る ——
    **✅ もそのときに付く**（`delivered_at` を立てる場所は 1 つ）。
  */
  it("(再送) で拾い直せて、そのときに ✅ が付く", async () => {
    const runKey = await seedRun({ projectId, status: "running" });

    const { response, settle } = await mcpCall(
      askHumanCall({ runKey, question: "どちら", options: ["A", "B"] }),
    );
    await nudge(response);
    await waitUntilTrue(
      async () => (await askRows())[0]?.message_id !== null,
      "問いが Discord に出る",
    );

    // 依頼者が答えてから、握りが落ちる。
    await applyInbound(env, {
      messageId: HUMAN_MESSAGE_ID,
      channelId: THREAD_ID,
      authorId: OWNER_ID,
      authorIsBot: false,
      content: "B で",
    });
    await response.body?.cancel();
    await settle();

    // 落ちた直後の呼び直し。**`held_at` はまだ新しいが、答えが先に渡る。**
    const { response: again, settle: settleAgain } = await mcpCall(
      askHumanCall({ runKey, question: "(再送)" }),
    );
    expect(again.headers.get("content-type")).toContain("application/json");
    const body = (await again.json()) as Record<string, unknown>;
    await settleAgain();

    expect(toolStatusOf(body).answer).toBe("B で");
    expect(
      reactionCalls(MARK_HANDED).filter(
        (call) =>
          call.method === "PUT" && call.url.includes(`/${HUMAN_MESSAGE_ID}/`),
      ),
    ).toHaveLength(1);
  });
});

describe("ボタンで答えたときは付け替える相手が居ない", () => {
  /*
    **`answer_message_id` が NULL なら何もしない。** ボタン由来の回答には
    依頼者のメッセージが存在しないので、印を付ける相手が居ない ——
    ここで質問メッセージに ✅ を付けると「Claude の発言に印が付く」ことになる。
  */
  it("印を 1 つも触らない", async () => {
    const runKey = await seedRun({ projectId, status: "running" });

    const { response, settle } = await mcpCall(
      askHumanCall({ runKey, question: "どちら", options: ["A", "B"] }),
    );
    await nudge(response);
    await waitUntilTrue(
      async () => (await askRows())[0]?.message_id !== null,
      "問いが Discord に出る",
    );

    const askId = (await askRows())[0]?.ask_id ?? "";
    await env.DB.prepare(
      "UPDATE asks SET answer = 'A', answered_at = ? WHERE ask_id = ?",
    )
      .bind(Date.now(), askId)
      .run();

    await readSse(response);
    await settle();

    expect(reactionCalls(MARK_HANDED)).toEqual([]);
    expect((await askRows())[0]?.delivered_at).not.toBeNull();
  });
});
