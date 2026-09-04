import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHANNEL_ALPHA,
  runHeldAt,
  runStatus,
  seedRun,
  seedTwoProjects,
  THREAD_ID,
} from "../db/support.ts";
import {
  discordOk,
  jsonResponse,
  type OutboundStub,
  stubOutbound,
} from "../support/outbound.ts";
import { isToolError, mcpCall, toolStatusOf, toolText } from "./support.ts";

/*
  `report`（要件 `F-D1`・計画 P3b §3-4）。**握らない。**

  ここで固めたいのは 4 つ:

    1. `progress` は**枠の無い地の文**、`done` / `blocked` は**枠つき**（要件 `F-B5`）
    2. **台帳へ残すのが Discord へ出すより先** —— 出せなくても行が残る（要件 `N-7`）
    3. **`report(done)` は run を `done` にしない**（要件 `I-11`・`F-D3`）
    4. **触るのは `activity_at` だけ** —— `held_at` は握りの印（要件 `F-D5`）
*/

const MESSAGE_ID = "666666666666666666";

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

const eventRows = async (): Promise<
  readonly {
    id: number;
    run_key: string;
    kind: string;
    body: string;
    discord_message_id: string | null;
  }[]
> => {
  const { results } = await env.DB.prepare(
    "SELECT id, run_key, kind, body, discord_message_id FROM events ORDER BY id",
  ).all();
  return results as never;
};

const runActivityAt = async (runKey: string): Promise<number | null> => {
  const row = await env.DB.prepare(
    "SELECT activity_at FROM runs WHERE run_key = ?",
  )
    .bind(runKey)
    .first<{ activity_at: number | null }>();
  return row?.activity_at ?? null;
};

const report = async (input: {
  readonly runKey: string;
  readonly kind?: unknown;
  readonly body?: unknown;
}): Promise<Record<string, unknown>> => {
  const { response, settle } = await mcpCall({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "report",
      arguments: {
        run_key: input.runKey,
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        ...(input.body === undefined ? {} : { body: input.body }),
      },
    },
  });

  // **握らない。** SSE で返ってきたらここで落ちる。
  expect(response.headers.get("content-type")).toContain("application/json");
  const parsed = (await response.json()) as Record<string, unknown>;
  await settle();
  return parsed;
};

const payloadOf = (fragment: string): Record<string, unknown> =>
  JSON.parse(stub.callsTo(fragment)[0]?.body ?? "{}") as Record<
    string,
    unknown
  >;

describe("progress は枠の無い地の文（要件 F-B5）", () => {
  it("content に素で出て embeds を持たない", async () => {
    const runKey = await seedRun({ projectId, threadId: THREAD_ID });

    await report({
      runKey,
      kind: "progress",
      body: "テストを 12 本足しました",
    });

    const payload = payloadOf(`/channels/${THREAD_ID}/messages`);
    expect(payload.content).toBe("テストを 12 本足しました");
    expect(payload.embeds).toBeUndefined();
  });
});

describe("done / blocked は枠つき（状態が変わったとき）", () => {
  it.each([
    ["done", "🏁 完了"],
    ["blocked", "⛔ 進めません"],
  ])("%s は embed で出る", async (kind, title) => {
    const runKey = await seedRun({ projectId, threadId: THREAD_ID });

    await report({ runKey, kind, body: "PR は https://example.test/pr/1" });

    const payload = payloadOf(`/channels/${THREAD_ID}/messages`);
    expect(payload.content).toBeUndefined();
    const embeds = payload.embeds as readonly {
      title: string;
      description: string;
    }[];
    expect(embeds[0]?.title).toBe(title);
    expect(embeds[0]?.description).toBe("PR は https://example.test/pr/1");
  });
});

describe("events に残る", () => {
  it("行が立ち、出せたら discord_message_id が入る", async () => {
    const runKey = await seedRun({ projectId, threadId: THREAD_ID });

    await report({ runKey, kind: "progress", body: "進めています" });

    const rows = await eventRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      run_key: runKey,
      kind: "progress",
      body: "進めています",
      discord_message_id: MESSAGE_ID,
    });
    /*
      **id の実際の値を書かない。** `AUTOINCREMENT` は消した行の id を再利用しない
      ので、`beforeEach` の `DELETE FROM events` では**採番が 1 に戻らない**
      （実測: 4 本目のテストでは id が 4 になる）。

      **それが正しい挙動。** この表は run 詳細の時系列そのもので、
      id の単調増加が「起きた順」を供給している（`events_run_id_idx`）。
      テストが 1 を期待するのは、その性質を捨てろと言っているのと同じ。
    */
    expect(rows[0]?.id).toBeGreaterThan(0);
  });

  /*
    **台帳へ残すのが Discord へ出すより先**（要件 `N-7`）。逆順にすると、
    出せなかった report が台帳から消える。列が NULL のまま並ぶことが
    「D1 にはあるが Discord には出ていない」の表示になる。
  */
  it("Discord に出せなくても行が残り、discord_message_id は NULL", async () => {
    stubOutbound([["discord.com", () => jsonResponse({ message: "no" }, 403)]]);
    const runKey = await seedRun({ projectId, threadId: THREAD_ID });

    const body = await report({
      runKey,
      kind: "progress",
      body: "出せない報告",
    });

    const [row] = await eventRows();
    expect(row?.body).toBe("出せない報告");
    expect(row?.discord_message_id).toBeNull();
    // **本題は止めない**が、届いていないことは Claude に伝える。
    expect(isToolError(body)).toBe(false);
    expect(toolText(body)).toContain("届いていません");
  });

  it("スレッドが無ければ親チャンネルへ出す", async () => {
    const runKey = await seedRun({ projectId, threadId: null });

    await report({ runKey, kind: "progress", body: "進めています" });

    expect(stub.callsTo(`/channels/${CHANNEL_ALPHA}/messages`)).toHaveLength(1);
  });

  it("何度でも追記できる（id が増える）", async () => {
    const runKey = await seedRun({ projectId, threadId: THREAD_ID });

    await report({ runKey, kind: "progress", body: "1 本目" });
    await report({ runKey, kind: "progress", body: "2 本目" });

    expect((await eventRows()).map((row) => row.body)).toEqual([
      "1 本目",
      "2 本目",
    ]);
  });
});

describe("report(done) は run を終わらせない（要件 I-11・F-D3）", () => {
  /*
    **ここが崩れるとスレッドが 1 回で死ぬ。** `report(done)` は「この作業が
    終わった」の報告で、会話の終了ではない。終了は `SessionEnd`（P5）。
  */
  it("status が done にならない", async () => {
    const runKey = await seedRun({ projectId, status: "running" });

    await report({ runKey, kind: "done", body: "終わりました" });

    expect(await runStatus(runKey)).toBe("running");
  });

  it("finished_at も入らない", async () => {
    const runKey = await seedRun({ projectId, status: "running" });

    await report({ runKey, kind: "done", body: "終わりました" });

    const row = await env.DB.prepare(
      "SELECT finished_at FROM runs WHERE run_key = ?",
    )
      .bind(runKey)
      .first<{ finished_at: number | null }>();
    expect(row?.finished_at).toBeNull();
  });

  it("done のあとも report を続けられる", async () => {
    const runKey = await seedRun({ projectId, status: "running" });

    await report({ runKey, kind: "done", body: "一区切り" });
    const body = await report({ runKey, kind: "progress", body: "続きます" });

    expect(isToolError(body)).toBe(false);
    expect(await eventRows()).toHaveLength(2);
  });
});

describe("触るのは activity_at だけ（要件 F-D5）", () => {
  it("activity_at が入る", async () => {
    const runKey = await seedRun({ projectId });
    const before = Date.now();

    await report({ runKey, kind: "progress", body: "進めています" });

    expect(await runActivityAt(runKey)).toBeGreaterThanOrEqual(before);
  });

  /*
    **`held_at` を触らない。** あれは握りが生きている印で、`report` が動かすと
    「死んだ問いへ回答を書き込む」に戻る（kanata が 1 本で兼用していた箇所）。
  */
  it("held_at を触らない", async () => {
    const heldAt = 1_788_400_000_000;
    const runKey = await seedRun({ projectId, heldAt });

    await report({ runKey, kind: "progress", body: "進めています" });

    expect(await runHeldAt(runKey)).toBe(heldAt);
  });

  it("held_at が NULL のままなら NULL のまま", async () => {
    const runKey = await seedRun({ projectId, heldAt: null });

    await report({ runKey, kind: "progress", body: "進めています" });

    expect(await runHeldAt(runKey)).toBeNull();
  });
});

describe("受け取らない形", () => {
  it("存在しない run_key はエラー", async () => {
    const body = await report({
      runKey: "OFFDESK-dead0000dead0000",
      kind: "progress",
      body: "x",
    });

    expect(isToolError(body)).toBe(true);
    expect(await eventRows()).toEqual([]);
  });

  it.each(["done", "failed", "abandoned"])(
    "終わった run（%s）はエラー",
    async (status) => {
      const runKey = await seedRun({ projectId, status });

      const body = await report({ runKey, kind: "progress", body: "x" });

      expect(isToolError(body)).toBe(true);
      expect(toolStatusOf(body).status).toBe("closed");
      expect(await eventRows()).toEqual([]);
    },
  );

  it.each([
    ["kind が無い", { body: "x" }],
    ["知らない kind", { kind: "zombie", body: "x" }],
    ["Claude に出せない kind（stop_hook）", { kind: "stop_hook", body: "x" }],
    ["Claude に出せない kind（error）", { kind: "error", body: "x" }],
    ["body が無い", { kind: "progress" }],
    ["body が空", { kind: "progress", body: "   " }],
    ["body が文字列でない", { kind: "progress", body: 42 }],
  ])("%s はエラー（行を作らない）", async (_label, args) => {
    const runKey = await seedRun({ projectId });

    const body = await report({ runKey, ...args });

    expect(isToolError(body)).toBe(true);
    expect(await eventRows()).toEqual([]);
    expect(stub.calls).toEqual([]);
  });

  it("長すぎる body はエラー", async () => {
    const runKey = await seedRun({ projectId });

    const body = await report({
      runKey,
      kind: "progress",
      body: "あ".repeat(2_000),
    });

    expect(toolText(body)).toContain("長すぎます");
    expect(await eventRows()).toEqual([]);
  });
});
