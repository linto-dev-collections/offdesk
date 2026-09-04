import { env } from "cloudflare:workers";
import { insertAsk } from "@offdesk/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MARK_HANDED, MARK_SEEN } from "../../src/worker/discord/marks.ts";
import {
  askRows,
  db,
  inboxRows,
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
  isToolError,
  mcpCall,
  readSse,
  toolStatusOf,
} from "./support.ts";

/*
  **作業中に溜まった素の文が、次の `ask_human` で渡る**
  （要件 `F-C2` の 2 行目・計画 P4 の完了条件）。

  ここが `ask_human` の 6 段の 4 段目。**質問を出さずにその文を返す** ——
  依頼者は既に喋っているので、聞き返す前に読ませる。

  段の位置が効いている:

    - **3 段目（握りが生きている）より後**: 握りが生きているなら 2 本目は握らない
    - **5 段目（未回答の問いを握り直す）より前**: 逆にすると、答えの来ない問いを
      握り直している間に依頼者が書いた文が届かない
*/

const ASK_ID = "ask_3333333333333333";

let projectId: string;
let stub: OutboundStub;

beforeEach(async () => {
  const { alpha } = await seedTwoProjects();
  projectId = alpha;
  stub = stubOutbound([["discord.com", discordOk({})]]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const queue = async (
  runKey: string,
  bodies: readonly string[],
): Promise<void> => {
  for (const [index, body] of bodies.entries()) {
    await env.DB.prepare(
      `INSERT INTO inbox (run_key, author_discord_user_id, message_id, body)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(runKey, OWNER_ID, `66666666666666666${index}`, body)
      .run();
  }
};

/** **握らずに JSON で返ったこと**を確かめて本文を読む（渡すだけなら握る理由がない）。 */
const ask = async (
  runKey: string,
  question = "次はどうしますか",
): Promise<Record<string, unknown>> => {
  const { response, settle } = await mcpCall(
    askHumanCall({ runKey, question, options: ["A", "B"] }),
  );
  expect(response.headers.get("content-type")).toContain("application/json");
  const body = (await response.json()) as Record<string, unknown>;
  await settle();
  return body;
};

const reactionCalls = (emoji: string) =>
  stub.callsTo(`/reactions/${encodeURIComponent(emoji)}/@me`);

describe("溜まった文を渡す", () => {
  it("status: answered で本文が返る", async () => {
    const runKey = await seedRun({ projectId });
    await queue(runKey, ["README も直して"]);

    const status = toolStatusOf(await ask(runKey));

    expect(status.status).toBe("answered");
    expect(status.answer).toBe("README も直して");
    /*
      **`ask_id` は付かない**（問いが存在しない）。Claude 側の扱いは回答と
      同じでよいので、新しい語彙を作らない。
    */
    expect(status.ask_id).toBeUndefined();
  });

  it("「質問は出していない」ことを note で伝える", async () => {
    const runKey = await seedRun({ projectId });
    await queue(runKey, ["README も直して"]);

    const status = toolStatusOf(await ask(runKey));

    expect(status.note).toContain("質問は出していません");
  });

  /** **Discord に質問を出さない。** 依頼者は既に喋っている。 */
  it("Discord へ何も出さない（印の付け替え以外）", async () => {
    const runKey = await seedRun({ projectId });
    await queue(runKey, ["README も直して"]);

    await ask(runKey);

    /*
      **`POST` で絞る。** 印の URL も `/messages/<id>/reactions/…` を含むので、
      パスの一部だけで数えると付け替えを「投稿」と数えてしまう。
    */
    const posts = stub
      .callsTo(`/channels/${THREAD_ID}/messages`)
      .filter((call) => call.method === "POST");
    expect(posts).toEqual([]);
    expect(await askRows()).toEqual([]);
  });

  it("複数行が 1 つに畳まれて渡る", async () => {
    const runKey = await seedRun({ projectId });
    await queue(runKey, ["1 行目", "2 行目", "3 行目"]);

    const status = toolStatusOf(await ask(runKey));

    expect(status.answer).toBe("1 行目\n\n2 行目\n\n3 行目");
  });

  /** **`taken_at` を立てるのと同じ場所で ✅ に付け替える**（要件 `I-3`・`F-C4`）。 */
  it("taken を立てて 👀 を ✅ に付け替える", async () => {
    const runKey = await seedRun({ projectId });
    await queue(runKey, ["README も直して"]);

    await ask(runKey);

    const [row] = await inboxRows();
    expect(row?.taken_at).not.toBeNull();
    expect(row?.taken_by_run_key).toBe(runKey);
    expect(reactionCalls(MARK_HANDED)).toHaveLength(1);
    expect(
      reactionCalls(MARK_SEEN).filter((call) => call.method === "DELETE"),
    ).toHaveLength(1);
  });

  it("run が running に戻る", async () => {
    const runKey = await seedRun({ projectId, status: "waiting" });
    await queue(runKey, ["README も直して"]);

    await ask(runKey);

    expect(await runStatus(runKey)).toBe("running");
  });

  /*
    **2 回目は同じ文を返さない。** 印を立てているので `peek` に出てこない ——
    ここが崩れると、同じ文を毎回返して会話が進まなくなる。
  */
  it("2 回目は溜まった文ではなく質問を立てる", async () => {
    const runKey = await seedRun({ projectId });
    await queue(runKey, ["README も直して"]);
    await ask(runKey);

    const { response, settle } = await mcpCall(
      askHumanCall({ runKey, question: "次は？", options: ["A"] }),
    );
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    await readSse(response);
    await settle();

    const [row] = await askRows();
    expect(row?.question).toBe("次は？");
  });

  it("溜まっていなければ普通に質問を立てる", async () => {
    const runKey = await seedRun({ projectId });

    const { response, settle } = await mcpCall(
      askHumanCall({ runKey, question: "次は？", options: ["A"] }),
    );
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    await readSse(response);
    await settle();

    expect((await askRows())[0]?.question).toBe("次は？");
  });
});

describe("段の順序", () => {
  /*
    **握りが生きているなら、溜まった文より先に `pending` で降りる**（脅威 16）。
    2 本目のストリームを開かないのが目的で、降りた Claude は `ask_wait` か
    次の `ask_human` で溜まった文を受け取れる。
  */
  it("握りが生きていれば pending が勝つ", async () => {
    const runKey = await seedRun({
      projectId,
      status: "waiting",
      heldAt: Date.now(),
    });
    await insertAsk(
      db(),
      { askId: ASK_ID, runKey, question: "どちら", options: ["A", "B"] },
      Date.now(),
    );
    await queue(runKey, ["README も直して"]);

    const status = toolStatusOf(await ask(runKey));

    expect(status.status).toBe("pending");
    expect((await inboxRows())[0]?.taken_at).toBeNull();
  });

  /*
    **答えが入っている問いは、溜まった文より先に渡す**（要件 `I-3`）。
    あちらは依頼者が「見た問いに答えた」もので、こちらは独立した発言 ——
    順序を逆にすると、答えが宙に浮いたまま次の話に進む。
  */
  it("配達していない答えがあればそちらが勝つ", async () => {
    const runKey = await seedRun({ projectId, status: "waiting" });
    await insertAsk(
      db(),
      { askId: ASK_ID, runKey, question: "どちら", options: ["A", "B"] },
      Date.now(),
    );
    await env.DB.prepare(
      "UPDATE asks SET answer = 'A', answered_at = ? WHERE ask_id = ?",
    )
      .bind(Date.now(), ASK_ID)
      .run();
    await queue(runKey, ["README も直して"]);

    const status = toolStatusOf(await ask(runKey));

    expect(status.answer).toBe("A");
    expect(status.ask_id).toBe(ASK_ID);
    expect((await inboxRows())[0]?.taken_at).toBeNull();
  });

  /*
    **未回答の問いを握り直すより先に、溜まった文を渡す**（P4 で足した段）。
    逆にすると、答えの来ない問いを握っている 15 分の間、**依頼者が既に書いた文が
    届かない** —— 依頼者から見れば「👀 は付いたのに何も起きない」。
  */
  it("未回答の問いがあっても溜まった文が先に渡る", async () => {
    const runKey = await seedRun({
      projectId,
      status: "waiting",
      /*
        **握りは落ちている。** ここは `HELD_ALIVE_MS`（60 秒）で判定する ——
        `INBOUND_HELD_WINDOW_MS`（`decideInbound` 側・テストでは 200ms）とは
        別の窓なので、縮めても効かない（脅威 16 の検査は環境変数で緩めない）。
      */
      heldAt: Date.now() - 70_000,
    });
    await insertAsk(
      db(),
      { askId: ASK_ID, runKey, question: "どちら", options: ["A", "B"] },
      Date.now(),
    );
    await queue(runKey, ["やっぱり C で"]);

    const status = toolStatusOf(await ask(runKey));

    expect(status.answer).toBe("やっぱり C で");
    // 問いはそのまま残る（Discord に出したままなので、後で握り直せる）。
    expect((await askRows())[0]?.answer).toBeNull();
  });

  /** 終端の run では渡さない（誰も読まない。脅威 16）。 */
  it.each(["done", "failed", "abandoned"])(
    "run が %s なら渡さない",
    async (status) => {
      const runKey = await seedRun({ projectId, status });
      await queue(runKey, ["README も直して"]);

      const body = await ask(runKey);

      expect(isToolError(body)).toBe(true);
      expect(toolStatusOf(body).status).toBe("closed");
      expect((await inboxRows())[0]?.taken_at).toBeNull();
    },
  );
});
