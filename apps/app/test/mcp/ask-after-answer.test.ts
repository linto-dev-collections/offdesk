import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyInbound } from "../../src/worker/discord/inbound.ts";
import { askRows, seedRun, seedTwoProjects, THREAD_ID } from "../db/support.ts";
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
  **答えを受け取った直後に、もう 1 度聞けるか**（2026-09-05 に本番で踏んだ）。

  ## 症状

  1 回目の問いに依頼者がスレッドへ素で答え、Claude が調査して 30 秒後に
  2 回目の `ask_human` を呼んだところ、**「この run では既に別の ask_human が
  回答を待っています」で断られた** —— 握りは 1 本も走っていないのに。
  応答に `ask_id` も無かったので `ask_wait` で待ち直す手も無く、Claude は
  ボタンを諦めて「テキストで返信してください」と自分で書いた。

  台帳から復元した順序（`OFFDESK-02b87f92aa246154`）:

  ```txt
  02:20:23  ask_human #1 → 投稿（options 3 件）
  ~02:20:53 握りの最後のハートビート（held_at。ASK_TOUCH_MS = 15 秒間隔）
  02:21:03  依頼者が素の文で回答
  02:21:07  握りが答えを渡して終了。held_at は ~02:20:53 のまま残る
  02:21:07〜02:21:53  ← この窓（HELD_ALIVE_MS = 60 秒）で 2 本目が断られた
  02:22:19  同じ呼び出しが通った（窓が切れただけ）
  ```

  ## ここで固めること

  **時間で待たない。** 「握りが終わった直後」は `held_at` が新しいまま
  未配達の問いが無い状態なので、**1 本目を本当に答えさせれば**その形が作れる
  （種で `held_at` を立てるだけでは、この経路は再現できない）。
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

/** 1 本目を握って、素の文で答えさせて、`answered` まで進める。 */
const answerFirstAsk = async (runKey: string): Promise<void> => {
  const { response, settle } = await mcpCall(
    askHumanCall({ runKey, question: "どちらにしますか", options: ["A", "B"] }),
  );
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
    content: "このリポジトリに readme ファイルはありますか",
  });
  expect(outcome.decision).toBe("answer");

  const frames = await readSse(response);
  await settle();
  expect(toolStatusOf(finalResult(frames))).toMatchObject({
    status: "answered",
  });
};

const secondAsk = (runKey: string) =>
  mcpCall(
    askHumanCall({
      runKey,
      id: 2,
      question: "README.md を作りましょうか",
      options: ["作る", "作らない"],
    }),
  );

describe("答えを渡した直後の 2 本目", () => {
  /*
    **握れていれば SSE で降りてくる。** 断られると JSON で即座に返るので、
    content-type だけで見分けられる（本番で起きたのはこちら）。
  */
  it("握れる（pending で断らない）", async () => {
    const runKey = await seedRun({ projectId, status: "running" });
    await answerFirstAsk(runKey);

    const { response, settle } = await secondAsk(runKey);
    await nudge(response);

    expect(response.headers.get("content-type")).toContain("text/event-stream");

    await waitUntilTrue(
      async () => (await askRows()).length === 2,
      "2 本目の問いが台帳に入る",
    );
    expect((await askRows())[1]?.options).toBe(
      JSON.stringify(["作る", "作らない"]),
    );

    await response.body?.cancel();
    await settle();
  });

  /** **ボタンが出る。** 本番では 2 本目が出せず、Claude が地の文で聞き直した。 */
  it("2 本目の問いが Discord に出る", async () => {
    const runKey = await seedRun({ projectId, status: "running" });
    await answerFirstAsk(runKey);

    const { response, settle } = await secondAsk(runKey);
    await nudge(response);
    await waitUntilTrue(
      async () => (await askRows())[1]?.message_id !== null,
      "2 本目が Discord に出る",
    );

    const posts = stub
      .callsTo(`/channels/${THREAD_ID}/messages`)
      .filter((call) => call.method === "POST");
    expect(posts).toHaveLength(2);

    await response.body?.cancel();
    await settle();
  });

  /*
    **印は下ろさない**（`mcp/server.ts` の why）。`markRunResumed` は握りが
    生きている間にも呼ばれるので、印を下ろす側で直すと脅威 16 の防御が穴になる
    —— 直したのは読み側（未配達の問いが無ければ断らない）。
  */
  it("held_at は残ったまま（直したのは読み側）", async () => {
    const runKey = await seedRun({ projectId, status: "running" });
    await answerFirstAsk(runKey);

    const row = await env.DB.prepare(
      "SELECT held_at FROM runs WHERE run_key = ?",
    )
      .bind(runKey)
      .first<{ held_at: number | null }>();

    expect(row?.held_at).not.toBeNull();
  });
});
