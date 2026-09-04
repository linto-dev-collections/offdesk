import { env } from "cloudflare:workers";
import { insertAsk } from "@offdesk/db";
import type { InboundMessage } from "@offdesk/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyInbound } from "../../src/worker/discord/inbound.ts";
import { MARK_HANDED, MARK_SEEN } from "../../src/worker/discord/marks.ts";
import {
  askRows,
  CHANNEL_ALPHA,
  db,
  inboxRows,
  runStatus,
  seedRun,
  seedTwoProjects,
  THREAD_ID,
} from "../db/support.ts";
import {
  discordOk,
  type OutboundStub,
  stubOutbound,
} from "../support/outbound.ts";
import { OWNER_ID, STRANGER_ID } from "./support.ts";

/*
  素の文の 4 通りの判定（要件 `F-C1`〜`F-C6`・計画 P4 §3-5）。

  **`applyInbound` を直に呼ぶ。** DO を通さないのは、計画 P4 §3-3 が
  「判定を DO に書かない」と定めているから —— ソケットを張らずに 4 通りを
  全部踏めることが、あの分割の目的そのもの。

  ここで固めたいのは 4 つ:

    1. **拾わない相手を拾わない**（bot 自身・持ち主以外・親チャンネル。脅威 14）
    2. **待っている質問への回答になる**（👀 が付き、ボタンが消える）
    3. **作業中は溜まる**（同じメッセージを 2 回積まない）
    4. **終わっていれば起こし直す**（前の run が `abandoned` になってから立つ）
*/

const MESSAGE_ID = "777777777777777777";
const ASK_ID = "ask_2222222222222222";

let projectId: string;
let stub: OutboundStub;

beforeEach(async () => {
  const { alpha } = await seedTwoProjects();
  projectId = alpha;
  stub = stubOutbound([
    ["discord.com", discordOk({ messageId: "888888888888888888" })],
    ["api.anthropic.com", () => Response.json({})],
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const message = (overrides: Partial<InboundMessage> = {}): InboundMessage => ({
  messageId: MESSAGE_ID,
  channelId: THREAD_ID,
  authorId: OWNER_ID,
  authorIsBot: false,
  content: "README も直して",
  ...overrides,
});

const deliver = (overrides: Partial<InboundMessage> = {}) =>
  applyInbound(env, message(overrides));

/** 印の URL は絵文字をエンコードした形。**定数から組む**（手で書くと encoding がずれる）。 */
const reactionCalls = (emoji: string) =>
  stub.callsTo(`/reactions/${encodeURIComponent(emoji)}/@me`);

const seedAsk = async (input: {
  readonly runKey: string;
  readonly askId?: string;
  readonly messageId?: string | null;
}): Promise<string> => {
  const askId = input.askId ?? ASK_ID;
  await insertAsk(
    db(),
    {
      askId,
      runKey: input.runKey,
      question: "どちらにしますか",
      options: ["A", "B"],
    },
    Date.now(),
  );
  if (input.messageId !== null) {
    await env.DB.prepare("UPDATE asks SET message_id = ? WHERE ask_id = ?")
      .bind(input.messageId ?? "555555555555555555", askId)
      .run();
  }
  return askId;
};

describe("拾わない相手（脅威 14）", () => {
  /*
    **bot 自身の発言を必ず落とす。** 落とさないと自分の `report` が自分の入力になり、
    無限ループになる（report → MESSAGE_CREATE → 溜める → 渡す → report …）。
  */
  it("bot 自身の発言は何も起きない", async () => {
    const runKey = await seedRun({ projectId });

    const outcome = await deliver({ authorIsBot: true });

    expect(outcome).toEqual({ decision: "ignore", runKey: null });
    expect(await inboxRows()).toEqual([]);
    expect(stub.calls).toEqual([]);
    expect(await runStatus(runKey)).toBe("running");
  });

  it("持ち主以外の発言は何も起きない", async () => {
    await seedRun({ projectId });

    const outcome = await deliver({ authorId: STRANGER_ID });

    expect(outcome.decision).toBe("ignore");
    expect(await inboxRows()).toEqual([]);
    // **何も出さない。** 他の人の雑談に bot が反応して回るのを避ける。
    expect(stub.calls).toEqual([]);
  });

  /** **未設定なら誰も通らない**（要件 `I-2` の fail-closed）。 */
  it("OWNER_DISCORD_USER_ID が空なら誰も通らない", async () => {
    await seedRun({ projectId });

    const outcome = await applyInbound(
      { ...env, OWNER_DISCORD_USER_ID: "" },
      message(),
    );

    expect(outcome.decision).toBe("ignore");
    expect(await inboxRows()).toEqual([]);
  });

  /*
    **親チャンネルに書いた文は拾わない**（要件 `F-C3`）。`runs.thread_id` を
    引くので親チャンネル id では当たらない —— 要件 `I-4` が「スレッドを
    作れなかった run の `thread_id` は NULL」と定めているのがこれを成り立たせている。
  */
  it("親チャンネルの発言は何も起きない", async () => {
    await seedRun({ projectId });

    const outcome = await deliver({ channelId: CHANNEL_ALPHA });

    expect(outcome.decision).toBe("ignore");
    expect(await inboxRows()).toEqual([]);
    expect(stub.calls).toEqual([]);
  });

  it("offdesk が知らないスレッドの発言は何も起きない", async () => {
    const outcome = await deliver({ channelId: "999999999999999999" });

    expect(outcome.decision).toBe("ignore");
    expect(stub.calls).toEqual([]);
  });

  it.each([
    ["空文字", ""],
    ["空白だけ", "   \n  "],
  ])(
    "本文が %s なら何も起きない（添付だけの発言）",
    async (_label, content) => {
      await seedRun({ projectId });

      const outcome = await deliver({ content });

      expect(outcome.decision).toBe("ignore");
      expect(await inboxRows()).toEqual([]);
    },
  );

  /*
    **スレッドを持たない run は起こし直せない**（要件 `F-A7`）。そもそも
    `thread_id` が NULL なので `findRunByThread` が当たらない ——
    ここが当たるようになったら `I-4` が破れている。
  */
  it("thread_id が NULL の run には届かない", async () => {
    await seedRun({ projectId, threadId: null });

    const outcome = await deliver();

    expect(outcome.decision).toBe("ignore");
  });
});

describe("待っている質問がある → 回答（要件 F-C2 の 1 行目）", () => {
  const seedWaiting = async () => {
    const runKey = await seedRun({
      projectId,
      status: "waiting",
      heldAt: Date.now(),
    });
    await seedAsk({ runKey });
    return runKey;
  };

  it("asks に answer と answer_message_id が入る", async () => {
    const runKey = await seedWaiting();

    const outcome = await deliver();

    expect(outcome).toEqual({ decision: "answer", runKey });
    const [row] = await askRows();
    expect(row?.answer).toBe("README も直して");
    expect(row?.answered_by_discord_user_id).toBe(OWNER_ID);
    /*
      **`answer_message_id` がこの経路の要。** ✅ に付け替える相手が誰かは
      この 1 列だけが知っている（要件 `I-3`）—— 印を変えるのは
      `delivered_at` を立てる側（握り）で、そこには元メッセージの情報が無い。
    */
    expect(row?.answer_message_id).toBe(MESSAGE_ID);
  });

  it("👀 が付く", async () => {
    await seedWaiting();

    await deliver();

    expect(reactionCalls(MARK_SEEN)).toHaveLength(1);
    expect(reactionCalls(MARK_SEEN)[0]?.method).toBe("PUT");
  });

  /*
    **ここでは ✅ にしない。** 台帳に答えが入っただけで、Claude へ渡ったわけではない ——
    渡るのは握っている `ask_human` の戻り値で、そのときに付け替わる（要件 `F-C4`）。
  */
  it("✅ はまだ付かない（渡してから）", async () => {
    await seedWaiting();

    await deliver();

    expect(reactionCalls(MARK_HANDED)).toEqual([]);
    const [row] = await askRows();
    expect(row?.delivered_at).toBeNull();
  });

  /** **質問からボタンが消えて `→ 書いた内容` が付く**（完了条件）。 */
  it("質問メッセージを書き換えてボタンを消す", async () => {
    await seedWaiting();

    await deliver();

    const [edit] = stub.callsTo(
      `/channels/${THREAD_ID}/messages/555555555555555555`,
    );
    expect(edit?.method).toBe("PATCH");
    const payload = JSON.parse(edit?.body ?? "{}") as {
      content?: string;
      components?: unknown[];
    };
    expect(payload.content).toContain("どちらにしますか");
    expect(payload.content).toContain("→ README も直して");
    // **空配列を明示する。** 省略すると Discord は「変更なし」と解釈してボタンが残る。
    expect(payload.components).toEqual([]);
  });

  it("run が running に戻る", async () => {
    const runKey = await seedWaiting();

    await deliver();

    expect(await runStatus(runKey)).toBe("running");
  });

  it("inbox には積まない", async () => {
    await seedWaiting();

    await deliver();

    expect(await inboxRows()).toEqual([]);
  });

  /*
    **握りが死んでいれば回答にしない**（要件 `F-C5`）。ここが緩いと、落ちた run の
    未回答の問いが**以後そのスレッドの発言を永久に飲み込む穴**になる。
  */
  it("握りが古ければ回答にせず溜める", async () => {
    const runKey = await seedRun({
      projectId,
      status: "waiting",
      heldAt: Date.now() - 60_000,
    });
    await seedAsk({ runKey });

    const outcome = await deliver();

    expect(outcome.decision).toBe("queue");
    expect((await askRows())[0]?.answer).toBeNull();
    expect(await inboxRows()).toHaveLength(1);
  });

  /** **配達済みの問いは対象にならない**（未回答のものだけ。計画 P4 §3-4）。 */
  it("答えが入っている問いには上書きしない", async () => {
    const runKey = await seedRun({
      projectId,
      status: "waiting",
      heldAt: Date.now(),
    });
    await seedAsk({ runKey });
    await env.DB.prepare(
      "UPDATE asks SET answer = 'A', answered_at = ? WHERE ask_id = ?",
    )
      .bind(Date.now(), ASK_ID)
      .run();

    const outcome = await deliver();

    expect(outcome.decision).toBe("queue");
    expect((await askRows())[0]?.answer).toBe("A");
  });
});

describe("作業中 → 溜まる（要件 F-C2 の 2 行目）", () => {
  it("inbox に積んで 👀 を付ける", async () => {
    const runKey = await seedRun({ projectId, status: "running" });

    const outcome = await deliver();

    expect(outcome).toEqual({ decision: "queue", runKey });
    const [row] = await inboxRows();
    expect(row).toMatchObject({
      run_key: runKey,
      author_discord_user_id: OWNER_ID,
      message_id: MESSAGE_ID,
      body: "README も直して",
      taken_at: null,
      taken_by_run_key: null,
    });
    expect(reactionCalls(MARK_SEEN)).toHaveLength(1);
  });

  it("本文の前後の空白を落とす", async () => {
    await seedRun({ projectId });

    await deliver({ content: "  直して  " });

    expect((await inboxRows())[0]?.body).toBe("直して");
  });

  /*
    **同じ Discord メッセージを 2 回積まない**（`inbox_message_uidx`）。
    Gateway は再接続時にイベントを再送しうる（resume の仕様）ので、
    **冪等性は D1 が担保する** —— アプリ側の記憶に頼ると isolate の入れ替わりで破れる。
  */
  it("同じメッセージが 2 回来ても 1 行だけ", async () => {
    await seedRun({ projectId });

    await deliver();
    const outcome = await deliver();

    expect(outcome.decision).toBe("duplicate");
    expect(await inboxRows()).toHaveLength(1);
  });

  /** **再送に 👀 を付け直さない。** 既に ✅ になっている文が 👀 に戻る。 */
  it("再送のときは印を触らない", async () => {
    await seedRun({ projectId });

    await deliver();
    const before = stub.calls.length;
    await deliver();

    expect(stub.calls.length).toBe(before);
  });

  it("違うメッセージは別の行になる", async () => {
    await seedRun({ projectId });

    await deliver({ messageId: "777777777777777771", content: "1 行目" });
    await deliver({ messageId: "777777777777777772", content: "2 行目" });

    expect((await inboxRows()).map((row) => row.body)).toEqual([
      "1 行目",
      "2 行目",
    ]);
  });

  /*
    **起動直後の 1 行で 2 本目を立てない。** `held_at` も `activity_at` も NULL の
    run は「作業中」で、`created_at` がそれを支えている（計画 P4 §3-4）。
  */
  it("起動直後（held_at も activity_at も NULL）でも溜める", async () => {
    await seedRun({ projectId, status: "queued", heldAt: null });

    const outcome = await deliver();

    expect(outcome.decision).toBe("queue");
  });
});
