import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { insertEvent } from "@offdesk/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/worker/index.ts";
import {
  CHANNEL_ALPHA,
  db,
  runFinishedAt,
  runStatus,
  seedProject,
  seedRun,
  THREAD_ID,
} from "../db/support.ts";
import { ORIGIN } from "../discord/support.ts";
import {
  jsonResponse,
  type OutboundStub,
  stubOutbound,
} from "../support/outbound.ts";

/*
  `POST /hooks/session-end`（要件 `F-D6`・`I-11`・計画 P5 §3-4）。

  **終わるのはここだけ。** `Stop` では終わらない（`context.test.ts` の側で固めてある）。

  **「枠を二重に出さない」は 2 段ある**（計画 P5 §3-4）——
  同じ `SessionEnd` が 2 回来たときと、`report(done)` と重なったとき。
*/

const TOKEN = "test-offdesk-token-0123456789abcdef";
const RUN = "OFFDESK-1111111111111111";

let projectId: string;
let stub: OutboundStub;

beforeEach(async () => {
  stub = stubOutbound([
    ["discord.com", () => jsonResponse({ id: "555555555555555555" })],
  ]);
  projectId = await seedProject({
    name: "alpha",
    discordChannelId: CHANNEL_ALPHA,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const post = async (
  body: unknown,
  init: { readonly token?: string | null } = {},
): Promise<Response> => {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const token = init.token === undefined ? TOKEN : init.token;
  if (token !== null) headers.authorization = `Bearer ${token}`;

  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${ORIGIN}/hooks/session-end`, {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
};

/** スレッドへ出した発言だけを数える（反応の URL も `/messages` を含む）。 */
const postedToThread = () =>
  stub
    .callsTo(`/channels/${THREAD_ID}/messages`)
    .filter((call) => call.method === "POST");

describe("口の守り（脅威 2）", () => {
  it.each([
    ["Bearer が無い", null],
    ["Bearer が違う", "wrong-token"],
  ])("%s なら 401", async (_label, token) => {
    const response = await post({ run_key: RUN }, { token });

    expect(response.status).toBe(401);
  });
});

describe("終わらせる", () => {
  it("status が done ＋ finished_at が入る", async () => {
    await seedRun({ projectId, runKey: RUN, status: "waiting" });

    const response = await post({ run_key: RUN });

    expect(response.status).toBe(204);
    expect(await runStatus(RUN)).toBe("done");
    expect(await runFinishedAt(RUN)).not.toBeNull();
  });

  it("終了の枠をスレッドに出す", async () => {
    await seedRun({ projectId, runKey: RUN });

    await post({ run_key: RUN });

    const posted = postedToThread();
    expect(posted).toHaveLength(1);
    expect(posted[0]?.body).toContain("🏁");
  });

  /*
    **スレッドが無い run には出さない**（要件 `F-A7`）。親チャンネルへ出すと、
    そのチャンネルの雑談の中に終了の枠だけが落ちる。
  */
  it("thread_id が NULL なら枠を出さない（台帳は畳む）", async () => {
    await seedRun({ projectId, runKey: RUN, threadId: null });

    await post({ run_key: RUN });

    expect(await runStatus(RUN)).toBe("done");
    expect(
      stub.callsTo("/messages").filter((c) => c.method === "POST"),
    ).toEqual([]);
  });
});

describe("枠を二重に出さない", () => {
  /** 1 段目: 同じ `SessionEnd` が 2 回来たとき。 */
  it("2 回目は 204 で枠を出さない", async () => {
    await seedRun({ projectId, runKey: RUN });

    await post({ run_key: RUN });
    const second = await post({ run_key: RUN });

    expect(second.status).toBe(204);
    expect(postedToThread()).toHaveLength(1);
  });

  /** 2 段目: `report(done)` が先に来ていたとき（あちらも 🏁 の枠）。 */
  it("report(done) が先にあれば枠を出さない（台帳は畳む）", async () => {
    await seedRun({ projectId, runKey: RUN });
    await insertEvent(
      db(),
      { runKey: RUN, kind: "done", body: "終わりました" },
      Date.now(),
    );

    await post({ run_key: RUN });

    expect(await runStatus(RUN)).toBe("done");
    expect(postedToThread()).toEqual([]);
  });

  /** `stop_hook` は終了の合図ではないので、枠は出る。 */
  it("stop_hook だけなら枠を出す", async () => {
    await seedRun({ projectId, runKey: RUN });
    await insertEvent(
      db(),
      { runKey: RUN, kind: "stop_hook", body: "1 ターン終了（100 tokens）" },
      Date.now(),
    );

    await post({ run_key: RUN });

    expect(postedToThread()).toHaveLength(1);
  });

  /*
    **既に終端の run には何もしない。** `failed` / `abandoned` で畳んだ run に
    `SessionEnd` が来ても、終了の枠を出すと「失敗したのに完了に見える」。
  */
  it.each(["failed", "abandoned", "done"])(
    "%s の run には枠を出さず、状態も変えない",
    async (status) => {
      await seedRun({ projectId, runKey: RUN, status });

      const response = await post({ run_key: RUN });

      expect(response.status).toBe(204);
      expect(await runStatus(RUN)).toBe(status);
      expect(postedToThread()).toEqual([]);
    },
  );
});

describe("壊れた通報で落ちない", () => {
  it.each([
    ["JSON ではない", "not json"],
    ["run_key が無い", {}],
    ["run_key が空", { run_key: "" }],
  ])("%s でも 204", async (_label, body) => {
    const response = await post(body);

    expect(response.status).toBe(204);
    expect(postedToThread()).toEqual([]);
  });

  /*
    **台帳に無い run_key でも 204**（計画 P5 §3-4 の 2）。hook は転写ログから
    `OFFDESK-<16hex>` を拾うので、offdesk 以外の用途で同じリポジトリに
    cloud session を開くと、run の無い通報が来うる。
  */
  it("台帳に無い run_key でも 204", async () => {
    const response = await post({ run_key: "OFFDESK-9999999999999999" });

    expect(response.status).toBe(204);
    expect(postedToThread()).toEqual([]);
  });

  /** Discord へ出せなくても台帳は畳んである（要件 `N-7`）。 */
  it("Discord が失敗しても status は done", async () => {
    vi.unstubAllGlobals();
    stub = stubOutbound([
      ["discord.com", () => new Response("boom", { status: 500 })],
    ]);
    await seedRun({ projectId, runKey: RUN });

    const response = await post({ run_key: RUN });

    expect(response.status).toBe(204);
    expect(await runStatus(RUN)).toBe("done");
  });
});
