import { RESEND_QUESTION } from "@offdesk/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { askRows, runHeldAt, seedRun, seedTwoProjects } from "../db/support.ts";
import { discordOk, stubOutbound } from "../support/outbound.ts";
import {
  askHumanCall,
  isToolError,
  mcpCall,
  toolStatusOf,
  toolText,
} from "./support.ts";

/*
  **握らない経路**（plans/security.md 脅威 16）。

  握りは最長 15 分 SSE を握るので、握らせてよい相手を先に絞る。ここで固めるのは
  「握らずに JSON で返る」こと ——**応答が `text/event-stream` でないこと自体が
  『資源を使っていない』の証拠**になる。

  `asks` に行が立っていないことも毎回見る。**誰も答えられないところへ質問を置かない。**
*/

let projectId: string;

beforeEach(async () => {
  const { alpha } = await seedTwoProjects();
  projectId = alpha;
  // 外向きの `fetch` は必ず捕まえる。**握らない経路なら 1 回も呼ばれない。**
  stubOutbound([["discord.com", discordOk({})]]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const ask = (input: Parameters<typeof askHumanCall>[0]) =>
  mcpCall(askHumanCall(input));

/**
 * **握らずに JSON で返ったこと**を確かめて本文を読む。
 * `text/event-stream` で返ってきたらここで落ちる —— それが「握ってしまった」の合図。
 */
const notHeld = async (input: Parameters<typeof askHumanCall>[0]) => {
  const { response, settle } = await ask(input);
  expect(response.headers.get("content-type")).toContain("application/json");
  const body = (await response.json()) as Record<string, unknown>;
  await settle();
  return body;
};

/** 握ったこと（SSE で返ったこと）だけを確かめて、本文は読まずに捨てる。 */
const held = async (input: Parameters<typeof askHumanCall>[0]) => {
  const { response, settle } = await ask(input);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  await response.body?.cancel();
  await settle();
};

describe("存在しない run_key", () => {
  it("握らずにエラーを返す（切り分け用の経路・要件 §9-1）", async () => {
    const body = await notHeld({
      runKey: "OFFDESK-dead0000dead0000",
      question: "どうしますか",
      options: ["はい"],
    });

    expect(isToolError(body)).toBe(true);
    expect(await askRows()).toEqual([]);
  });

  /*
    **この経路は診断の道具でもある。** 存在しない run で 1 回呼ばせれば、Discord に
    触れずに許可ドメイン・環境変数・MCP 認証・ツール発見・承認までを一度に確かめられる。
    だから文面が「接続は通っている」と名乗る必要がある——そこを固める。
  */
  it("「接続は通っている」ことを文面が名乗る", async () => {
    const body = await notHeld({
      runKey: "OFFDESK-dead0000dead0000",
      question: "どうしますか",
      options: ["はい"],
    });

    expect(toolText(body)).toContain("接続そのものは通っています");
  });

  it("run_key が空でも同じ経路に落ちる", async () => {
    const body = await notHeld({
      runKey: "",
      question: "どうしますか",
      options: ["はい"],
    });

    expect(isToolError(body)).toBe(true);
    expect(await askRows()).toEqual([]);
  });
});

describe("終わった run", () => {
  it.each(["done", "failed", "abandoned"])(
    "status が %s なら握らない",
    async (status) => {
      const runKey = await seedRun({ projectId, status });

      const body = await notHeld({
        runKey,
        question: "どうしますか",
        options: ["はい"],
      });

      expect(isToolError(body)).toBe(true);
      expect(toolStatusOf(body).status).toBe("closed");
      // **誰も答えられないところへ質問を置かない。**
      expect(await askRows()).toEqual([]);
    },
  );

  it.each(["queued", "running", "waiting"])(
    "status が %s なら握る",
    async (status) => {
      const runKey = await seedRun({ projectId, status });

      // 握りは SSE で返る。本文は読み切らない（ここで見たいのは「握った」ことだけ）。
      await held({ runKey, question: "どうしますか", options: ["はい"] });
    },
  );
});

describe("同じ run で握りを重ねない（脅威 16）", () => {
  it("握りが生きていれば 2 本目は即座に pending を返す", async () => {
    /*
      **時間で待たない。** 「1 本目が生きている」は `runs.held_at` が新しいことなので、
      種の時点でそれを立てておけば、2 本目の判断はその 1 行だけで決まる。
    */
    const runKey = await seedRun({ projectId, heldAt: Date.now() });

    const body = await notHeld({
      runKey,
      question: "どうしますか",
      options: ["はい"],
    });

    expect(toolStatusOf(body).status).toBe("pending");
    // 失敗ではない（1 本目が答えを受け取る）。
    expect(isToolError(body)).toBe(false);
    expect(await askRows()).toEqual([]);
  });

  it("握りが古ければ握れる（落ちた握りに永久に譲らない）", async () => {
    // ここが逆だと、1 度落ちた run は二度と質問できなくなる。
    const runKey = await seedRun({
      projectId,
      heldAt: Date.now() - 10 * 60_000,
    });

    await held({ runKey, question: "どうしますか", options: ["はい"] });
  });

  it("一度も握られていない run は握れる", async () => {
    const runKey = await seedRun({ projectId, heldAt: null });

    await held({ runKey, question: "どうしますか", options: ["はい"] });
  });

  /*
    **握る前に `held_at` を立てているか。** pump に任せると、その間に来た 2 本目が
    「握りは死んでいる」と判定して重なる（上の検査が空振りする）。
  */
  it("握りに入る時点で held_at が立っている", async () => {
    const runKey = await seedRun({ projectId, heldAt: null });
    const before = Date.now();

    await held({ runKey, question: "どうしますか", options: ["はい"] });

    const heldAt = await runHeldAt(runKey);
    expect(heldAt).not.toBeNull();
    expect(heldAt ?? 0).toBeGreaterThanOrEqual(before);
  });
});

describe("引数の検査", () => {
  it("問いが空なら握らない", async () => {
    const runKey = await seedRun({ projectId });

    const body = await notHeld({ runKey, question: "   ", options: ["はい"] });

    expect(isToolError(body)).toBe(true);
    expect(await askRows()).toEqual([]);
  });

  /*
    **P3a では選択肢が必須**（2026-09-04 の決定）。答える口はボタンだけで、
    スレッドへ素で書いた文が届くのは P4。選択肢 0 個の問いは誰も答えられないので、
    **握らずに**返す（握ると上限まで待って pending を返し、行き止まりになる）。
  */
  it("選択肢が無ければ握らない", async () => {
    const runKey = await seedRun({ projectId });

    const body = await notHeld({ runKey, question: "どうしますか" });

    expect(isToolError(body)).toBe(true);
    expect(toolText(body)).toContain("options が空");
    expect(await askRows()).toEqual([]);
  });

  it("選択肢が多すぎれば握らない（黙って削らない）", async () => {
    const runKey = await seedRun({ projectId });
    const options = Array.from({ length: 21 }, (_, i) => `o${i}`);

    const body = await notHeld({ runKey, question: "どれ", options });

    expect(toolText(body)).toContain("多すぎます");
    expect(await askRows()).toEqual([]);
  });

  /*
    **拾う問いが無いときの `(再送)` は握らない。**

    P3b で拾い直しが入ったので、`(再送)` は「直前の問いを拾い直せ」の合図になった
    （`pickup.test.ts` がその経路を見る）。**ただし拾うものが無ければ本物の問いが要る** ——
    ここが素通りすると「(再送)」だけが書かれた選択肢無しのメッセージが Discord に出る。
  */
  it("拾う問いが無ければ (再送) でも握らない", async () => {
    const runKey = await seedRun({ projectId });

    const body = await notHeld({ runKey, question: RESEND_QUESTION });

    expect(isToolError(body)).toBe(true);
    expect(toolText(body)).toContain("options が空");
    expect(await askRows()).toEqual([]);
  });

  it("(再送) を含むだけの長い問いは通す（本物の問いを殺さない）", async () => {
    const runKey = await seedRun({ projectId });

    await held({
      runKey,
      question: `${RESEND_QUESTION} この方針で進めてよいですか`,
      options: ["はい"],
    });
  });
});

describe("握らない経路では外へ 1 回も出ない", () => {
  it("Discord を叩かない", async () => {
    const stub = stubOutbound([["discord.com", discordOk({})]]);
    const runKey = await seedRun({ projectId, status: "done" });

    await notHeld({ runKey, question: "どうしますか", options: ["はい"] });

    expect(stub.calls).toEqual([]);
  });
});
