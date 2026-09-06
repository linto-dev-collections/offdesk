import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHANNEL_ALPHA,
  runCtx,
  seedProject,
  seedRun,
  THREAD_ID,
} from "../db/support.ts";
import { askHumanCall, mcpCall, nudge, waitUntilTrue } from "../mcp/support.ts";
import {
  discordOk,
  type OutboundStub,
  stubOutbound,
} from "../support/outbound.ts";

/*
  **Claude の発言の末尾に残量が出る**（要件 `F-D4`・計画 P5 の完了条件）。

  出す場所を発言の末尾に決めた理由（要件 `F-D4`）——
  スレッド名は Discord の「2 回 / 10 分」の制限で毎ターン更新できず、
  スレッド先頭の起動メッセージは見るのに上までスクロールが要り、
  別メッセージだと会話が bot の相槌で埋まる。

  **付けるのは地の文だけ。** `done` / `blocked` は「状態が変わった」を伝える枠なので、
  そこに残量を混ぜると合図が薄まる。
*/

const RUN = "OFFDESK-1111111111111111";
/**
 * 121,937 / 1,000,000 ＝ 12%（`claude-sonnet-5` は native で 1M の窓）。
 *
 * **`claude-opus-5` は使わない**（2026-09-06）。あれは Claude Code の既定が 200K で、
 * 1M は `[1m]` の変種でだけ開く —— ここで使うと「1M の窓を分母にする」ではなく
 * 「表の値をそのまま使う」しか試せない。
 */
const USED_TOKENS = 121_937;

let projectId: string;
let stub: OutboundStub;

beforeEach(async () => {
  stub = stubOutbound([["discord.com", discordOk({})]]);
  projectId = await seedProject({
    name: "alpha",
    discordChannelId: CHANNEL_ALPHA,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const postedBodies = (path: string): readonly string[] =>
  stub
    .callsTo(path)
    .filter((call) => call.method === "POST")
    .map((call) => call.body ?? "");

/**
 * `ask_human` は握るので SSE で返る。**本文は読まない** ——
 * 見たいのは Discord へ出た問いの形で、それは握りの `onOpen` が出す
 * （`waitUntil` の中なので、`mcpCall` が返った時点では出ていない）。
 */
const askAndWaitForPost = async (): Promise<void> => {
  const { response, settle } = await mcpCall(
    askHumanCall({ runKey: RUN, question: "どちらにしますか", options: ["A"] }),
  );
  expect(response.headers.get("content-type")).toContain("text/event-stream");

  /*
    **1 個読んで pump を歩かせる。** `TransformStream` の readable は
    highWaterMark が 0 なので、**クライアントが読むまで `onOpen` まで進まない**
    （P3b の実測）—— 読まずに待つと「問いが出ない」で固まる。
  */
  await nudge(response);

  await waitUntilTrue(
    async () => postedBodies(`/channels/${THREAD_ID}/messages`).length > 0,
    "問いが Discord へ出る",
  );

  await response.body?.cancel();
  await settle();
};

/**
 * 末尾に付く 1 行。**バーの有無で探さない**（2026-09-06）——
 * 窓を引けていないときはバーも `%` も出ない形になるので、
 * `-# ▓` で探すと**その行を「無い」と誤読する。**
 */
const contextOf = (raw: string): string => {
  const content = (JSON.parse(raw) as { content?: string }).content ?? "";
  const line = content.split("\n").find((row) => row.startsWith("-# "));
  return line ?? "";
};

describe("ask_human の問い", () => {
  it("末尾に残量の 1 行が付く", async () => {
    await seedRun({ projectId, runKey: RUN });
    await env.DB.prepare(
      `UPDATE runs SET ctx_used_tokens = ?, ctx_at = ?, ctx_model = ?
       WHERE run_key = ?`,
    )
      .bind(USED_TOKENS, Date.now(), "claude-sonnet-5", RUN)
      .run();

    await askAndWaitForPost();

    const body = postedBodies(`/channels/${THREAD_ID}/messages`)[0] ?? "";
    expect(contextOf(body)).toBe("-# ▓▓░░░░░░░░░░░░░░░░░░ 12% ・122k/1000k");
  });

  /*
    **1 度も通報が来ていなければ 1 行も出さない**（`0%` は嘘になる）。
    起動直後の 1 本目の問いは必ずこの状態。
  */
  it("通報がまだ無ければ 1 行も付かない", async () => {
    await seedRun({ projectId, runKey: RUN });
    expect((await runCtx(RUN))?.ctx_used_tokens).toBeNull();

    await askAndWaitForPost();

    const body = postedBodies(`/channels/${THREAD_ID}/messages`)[0] ?? "";
    expect(body).toContain("どちらにしますか");
    expect(contextOf(body)).toBe("");
  });

  /*
    **モデルが分からなければ既定の窓（200,000）に倒れる。** 分母がズレるので
    `61%` になるが、**生のトークン数を併記してあるので真値は見失わない**。
  */
  /** モデルが無ければ窓を引けないので、**分子だけ**を出す（要件 `F-D4`）。 */
  it("モデルが無ければ % を出さず、分子だけを出す", async () => {
    await seedRun({ projectId, runKey: RUN });
    await env.DB.prepare(
      "UPDATE runs SET ctx_used_tokens = ?, ctx_at = ? WHERE run_key = ?",
    )
      .bind(USED_TOKENS, Date.now(), RUN)
      .run();

    await askAndWaitForPost();

    const body = postedBodies(`/channels/${THREAD_ID}/messages`)[0] ?? "";
    expect(contextOf(body)).toBe("-# 122k 使用（窓が引けていません）");
  });
});

/** `report` は握らないので JSON で返る（SSE で返ったらそれ自体が異常）。 */
const report = async (kind: string, body: string): Promise<void> => {
  const { response, settle } = await mcpCall({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "report", arguments: { run_key: RUN, kind, body } },
  });

  expect(response.headers.get("content-type")).toContain("application/json");
  await response.json();
  await settle();
};

describe("report", () => {
  beforeEach(async () => {
    await seedRun({ projectId, runKey: RUN });
    await env.DB.prepare(
      `UPDATE runs SET ctx_used_tokens = ?, ctx_at = ?, ctx_model = ?
       WHERE run_key = ?`,
    )
      .bind(USED_TOKENS, Date.now(), "claude-sonnet-5", RUN)
      .run();
  });

  it("progress の末尾に残量が付く", async () => {
    await report("progress", "実装中です");

    const body = postedBodies(`/channels/${THREAD_ID}/messages`)[0] ?? "";
    expect(contextOf(body)).toBe("-# ▓▓░░░░░░░░░░░░░░░░░░ 12% ・122k/1000k");
  });

  /*
    **枠つき（`done` / `blocked`）には付けない。** 状態が変わった合図に
    残量を混ぜると合図が薄まるし、終わった run の残量には使い道がない。
  */
  it.each(["done", "blocked"])("%s の枠には付かない", async (kind) => {
    await report(kind, "終わりました");

    const raw = postedBodies(`/channels/${THREAD_ID}/messages`)[0] ?? "";
    expect(raw).toContain("embeds");
    expect(raw).not.toContain("-# ▓");
  });
});
