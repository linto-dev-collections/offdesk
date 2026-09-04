import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/worker/index.ts";
import {
  CHANNEL_ALPHA,
  eventRows,
  runActivityAt,
  runCtx,
  runHeldAt,
  runStatus,
  seedProject,
  seedRun,
} from "../db/support.ts";
import { ORIGIN } from "../discord/support.ts";

/*
  `POST /hooks/context`（要件 `F-D4`・`F-D5`・`F-D6`・計画 P5 §3-3）。

  **この口がいちばん危ないのは `held_at` を触ってしまうこと**（要件 `F-D5`）。
  hook は Claude が動いている限り定期的に鳴るので、ここで握りの印を更新すると
  **誰も待っていない問いが永久に「生きている」ことになり、死んだ問いへ
  回答を書き込む**（kanata が 1 本の列で兼用していて踏んだ形）。

  次に危ないのが **`Stop` で終わらせてしまうこと**（要件 `F-D6`・`I-11`）。
  `Stop` は 1 ターンごとに鳴る。
*/

const TOKEN = "test-offdesk-token-0123456789abcdef";
const RUN = "OFFDESK-1111111111111111";
const HELD_AT = 1_788_000_000_000;

let projectId: string;

beforeEach(async () => {
  projectId = await seedProject({
    name: "alpha",
    discordChannelId: CHANNEL_ALPHA,
  });
});

const usage = (over: Record<string, unknown> = {}) => ({
  input_tokens: 2,
  cache_creation_input_tokens: 21_935,
  cache_read_input_tokens: 100_000,
  output_tokens: 57,
  ...over,
});

const post = async (
  body: unknown,
  init: { readonly token?: string | null; readonly path?: string } = {},
): Promise<Response> => {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const token = init.token === undefined ? TOKEN : init.token;
  if (token !== null) headers.authorization = `Bearer ${token}`;

  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${ORIGIN}${init.path ?? "/hooks/context"}`, {
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

describe("口の守り（脅威 2）", () => {
  it("Bearer が無ければ 401", async () => {
    const response = await post(
      { run_key: RUN, event: "PreToolUse", usage: usage() },
      { token: null },
    );

    expect(response.status).toBe(401);
  });

  it("Bearer が違えば 401", async () => {
    const response = await post(
      { run_key: RUN, event: "PreToolUse", usage: usage() },
      { token: "wrong-token" },
    );

    expect(response.status).toBe(401);
  });
});

describe("残量を入れる", () => {
  it("ctx_at と ctx_used_tokens が対で入る（runs_ctx_pair_ck）", async () => {
    await seedRun({ projectId, runKey: RUN });

    const response = await post({
      run_key: RUN,
      event: "PreToolUse",
      model: "claude-opus-5",
      usage: usage(),
    });

    expect(response.status).toBe(204);

    const ctx = await runCtx(RUN);
    expect(ctx?.ctx_used_tokens).toBe(121_937);
    expect(ctx?.ctx_at).not.toBeNull();
    expect(ctx?.ctx_model).toBe("claude-opus-5");
  });

  /** **output は参考値。** 分子には入らないが、台帳には残す。 */
  it("output は分子に足さず、別の列に入る", async () => {
    await seedRun({ projectId, runKey: RUN });

    await post({
      run_key: RUN,
      event: "PreToolUse",
      usage: usage({ output_tokens: 999 }),
    });

    const ctx = await runCtx(RUN);
    expect(ctx?.ctx_used_tokens).toBe(121_937);
    expect(ctx?.ctx_output_tokens).toBe(999);
  });

  /*
    **`cache_creation_input_tokens` は `null` で来ることがある**
    （キャッシュを書かなかったターン）。`.default(0)` では素通りしないので、
    ここで落ちると**通報ごと捨てることになる。**
  */
  it("usage の欄が null でも 0 として数える", async () => {
    await seedRun({ projectId, runKey: RUN });

    await post({
      run_key: RUN,
      event: "PreToolUse",
      usage: {
        input_tokens: 5,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: 124_400,
        output_tokens: null,
      },
    });

    const ctx = await runCtx(RUN);
    expect(ctx?.ctx_used_tokens).toBe(124_405);
    expect(ctx?.ctx_output_tokens).toBe(0);
  });

  /** モデルが無くても分子は捨てない（対の CHECK に入れていない理由）。 */
  it("model が無くても残量は入る", async () => {
    await seedRun({ projectId, runKey: RUN });

    await post({ run_key: RUN, event: "PreToolUse", usage: usage() });

    const ctx = await runCtx(RUN);
    expect(ctx?.ctx_used_tokens).toBe(121_937);
    expect(ctx?.ctx_model).toBeNull();
  });
});

describe("握りの印を触らない（要件 F-D5）", () => {
  /*
    **これが P5 でいちばん大事な 1 本。** 触ると、落ちた run の未回答の問いが
    「生きている」ままになり、以後そのスレッドの発言を飲み込む穴になる。
  */
  it("held_at が変わらない", async () => {
    await seedRun({ projectId, runKey: RUN, heldAt: HELD_AT });

    await post({ run_key: RUN, event: "PreToolUse", usage: usage() });

    expect(await runHeldAt(RUN)).toBe(HELD_AT);
  });

  /** **`activity_at` は更新する。** hook が鳴っている ＝ セッションが息をしている。 */
  it("activity_at は更新する", async () => {
    await seedRun({ projectId, runKey: RUN });
    expect(await runActivityAt(RUN)).toBeNull();

    await post({ run_key: RUN, event: "Stop", usage: usage() });

    expect(await runActivityAt(RUN)).not.toBeNull();
  });
});

describe("Stop は終了ではない（要件 F-D6・I-11）", () => {
  /*
    kanata はここを間違えて `Stop` で `status='done'` を立てていたため、
    会話の途中で「🏁 セッションが終了しました」が出ていた
    （同じセッションが 8 回鳴らした記録がある）。**テスト名に残す。**
  */
  it("Stop で status が変わらない", async () => {
    await seedRun({ projectId, runKey: RUN, status: "waiting" });

    await post({ run_key: RUN, event: "Stop", usage: usage() });

    expect(await runStatus(RUN)).toBe("waiting");
  });

  it("Stop で finished_at が入らない", async () => {
    await seedRun({ projectId, runKey: RUN });

    await post({ run_key: RUN, event: "Stop", usage: usage() });

    const rows = await eventRows();
    expect(rows.map((row) => row.kind)).toEqual(["stop_hook"]);
    expect(await runStatus(RUN)).toBe("running");
  });

  it("Stop は events に 1 行だけ足す", async () => {
    await seedRun({ projectId, runKey: RUN });

    await post({ run_key: RUN, event: "Stop", usage: usage() });
    await post({ run_key: RUN, event: "Stop", usage: usage() });

    const rows = await eventRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.kind === "stop_hook")).toBe(true);
    // **転写ログの中身を本文に入れない**（脅威 12）。数値だけ。
    expect(rows[0]?.body).toContain("121937");
  });

  it("PreToolUse は events に何も足さない", async () => {
    await seedRun({ projectId, runKey: RUN });

    await post({ run_key: RUN, event: "PreToolUse", usage: usage() });

    expect(await eventRows()).toHaveLength(0);
  });
});

describe("壊れた通報で落ちない", () => {
  /*
    **hook を失敗させない**（計画 P5 §3-2）。4xx を返すと Cloudflare のログが
    赤くなり、切り分けのときに本物の異常と見分けがつかなくなる。
  */
  it.each([
    ["JSON ではない", "not json"],
    ["run_key が無い", { event: "PreToolUse", usage: {} }],
    ["run_key が空", { run_key: "", event: "PreToolUse", usage: {} }],
    ["event が知らない値", { run_key: RUN, event: "PostToolUse", usage: {} }],
    ["usage が無い", { run_key: RUN, event: "Stop" }],
    ["usage が配列", { run_key: RUN, event: "Stop", usage: [] }],
    [
      "負のトークン数",
      { run_key: RUN, event: "Stop", usage: { input_tokens: -1 } },
    ],
  ])("%s でも 204", async (_label, body) => {
    await seedRun({ projectId, runKey: RUN });

    const response = await post(body);

    expect(response.status).toBe(204);
    expect(await runCtx(RUN)).toMatchObject({ ctx_used_tokens: null });
  });

  /*
    **台帳に無い run_key でも 204。** `events.run_key` は外部キーなので、
    `Stop` で行を挿すと 500 になる —— 挿さないことで塞いである。
  */
  it("台帳に無い run_key の Stop でも 204（events は増えない）", async () => {
    const response = await post({
      run_key: "OFFDESK-9999999999999999",
      event: "Stop",
      usage: usage(),
    });

    expect(response.status).toBe(204);
    expect(await eventRows()).toHaveLength(0);
  });
});

describe("終端の run でも記録する", () => {
  /*
    `SessionEnd` の後に `Stop` が来ることはある。**状態は触らない**ので終端の
    意味は変わらず、最後の残量が残っていれば P7a の run 詳細が読める。
  */
  it("done の run にも残量が入り、status は変わらない", async () => {
    await seedRun({ projectId, runKey: RUN, status: "done" });

    await post({ run_key: RUN, event: "Stop", usage: usage() });

    expect(await runStatus(RUN)).toBe("done");
    expect((await runCtx(RUN))?.ctx_used_tokens).toBe(121_937);
  });
});
