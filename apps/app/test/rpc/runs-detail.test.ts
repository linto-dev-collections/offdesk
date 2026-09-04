import { env } from "cloudflare:workers";
import type { RunDetailOutput } from "@offdesk/contract";
import { DEFAULT_CONTEXT_WINDOW_TOKENS } from "@offdesk/domain";
import { beforeEach, describe, expect, it } from "vitest";
import { signIn } from "../auth/support.ts";
import { seedTwoProjects } from "../db/support.ts";
import {
  askIdOf,
  callRpc,
  rpcJson,
  runKeyOf,
  seedAsk,
  seedEvent,
  seedInbox,
  seedRun,
} from "./support.ts";

const THREAD_ID = "444444444444444444";
const GUILD_ID = "999999999999999999";
const NOW = Date.now();

let alpha = "";
let authed = new Headers();

beforeEach(async () => {
  alpha = (await seedTwoProjects()).alpha;
  authed = (await signIn()).headers;
});

const detail = async (runKey: string) =>
  await rpcJson<RunDetailOutput>("runs/detail", { runKey }, authed);

describe("POST /rpc/runs.detail", () => {
  it("未ログインなら 401", async () => {
    await seedRun({ runKey: runKeyOf(1), projectId: alpha });

    expect((await callRpc("runs/detail", { runKey: runKeyOf(1) })).status).toBe(
      401,
    );
  });

  /*
    **台帳に無い `run_key` は 404。** 出力の型に「無い」を入れると、
    画面側が「まだ読み込み中」と「その run は無い」を区別できなくなる。
  */
  it("台帳に無い run_key は 404", async () => {
    expect((await detail(runKeyOf(99))).status).toBe(404);
  });

  it("空の runKey は入力検証で落ちる", async () => {
    expect((await callRpc("runs/detail", { runKey: "" }, authed)).status).toBe(
      400,
    );
  });

  it("プロジェクト名とリポジトリが入って返る", async () => {
    await seedRun({ runKey: runKeyOf(1), projectId: alpha });

    const { status, body } = await detail(runKeyOf(1));

    expect(status).toBe(200);
    expect(body.projectName).toBe("offdesk-test");
    expect(body.repoUrl).toContain("github.com");
  });

  /** 詳細は全文（一覧が 120 字なのはそちらの都合）。 */
  it("prompt は切らない", async () => {
    const prompt = "あ".repeat(300);
    await seedRun({ runKey: runKeyOf(1), projectId: alpha, prompt });

    expect((await detail(runKeyOf(1))).body.prompt).toBe(prompt);
  });
});

describe("リンク", () => {
  it("スレッドがあれば Discord の URL が入る", async () => {
    await seedRun({
      runKey: runKeyOf(1),
      projectId: alpha,
      threadId: THREAD_ID,
    });

    expect((await detail(runKeyOf(1))).body.threadUrl).toBe(
      `https://discord.com/channels/${GUILD_ID}/${THREAD_ID}`,
    );
  });

  /** 完了条件「`thread_id` / `cc_session_url` が NULL なら出さない」。 */
  it("スレッドが無ければ threadUrl は null", async () => {
    await seedRun({ runKey: runKeyOf(1), projectId: alpha, threadId: null });

    expect((await detail(runKeyOf(1))).body.threadUrl).toBeNull();
  });

  it("cc セッションが無ければ ccSessionUrl は null", async () => {
    await seedRun({ runKey: runKeyOf(1), projectId: alpha, ccSession: null });

    expect((await detail(runKeyOf(1))).body.ccSessionUrl).toBeNull();
  });

  it("cc セッションがあれば URL が入る", async () => {
    await seedRun({
      runKey: runKeyOf(1),
      projectId: alpha,
      ccSession: { id: "sess-1", url: "https://example.test/session/sess-1" },
    });

    expect((await detail(runKeyOf(1))).body.ccSessionUrl).toBe(
      "https://example.test/session/sess-1",
    );
  });

  /** `cc_session_id` は出さない（URL だけで足りる。脅威 12 と同じ絞り方）。 */
  it("応答に cc_session_id は無い", async () => {
    await seedRun({
      runKey: runKeyOf(1),
      projectId: alpha,
      ccSession: { id: "sess-1", url: "https://example.test/session/sess-1" },
    });

    const text = await (
      await callRpc("runs/detail", { runKey: runKeyOf(1) }, authed)
    ).text();

    expect(text).not.toContain("ccSessionId");
  });
});

describe("時系列（3 表を混ぜる）", () => {
  beforeEach(async () => {
    await seedRun({
      runKey: runKeyOf(1),
      projectId: alpha,
      createdAt: NOW - 10_000,
    });

    // わざと表ごとにばらけた時刻で入れる（混ざっていなければ順序で分かる）。
    await seedEvent({
      runKey: runKeyOf(1),
      kind: "progress",
      body: "2 番目",
      createdAt: NOW - 8000,
    });
    await seedInbox({
      runKey: runKeyOf(1),
      body: "4 番目",
      createdAt: NOW - 6000,
    });
    await seedAsk({
      askId: askIdOf(1),
      runKey: runKeyOf(1),
      question: "1 番目",
      createdAt: NOW - 9000,
    });
    await seedAsk({
      askId: askIdOf(2),
      runKey: runKeyOf(1),
      question: "3 番目",
      createdAt: NOW - 7000,
    });
  });

  it("created_at の昇順に並ぶ", async () => {
    const { body } = await detail(runKeyOf(1));

    expect(
      body.timeline.map((entry) =>
        entry.kind === "ask" ? entry.question : entry.body,
      ),
    ).toEqual(["1 番目", "2 番目", "3 番目", "4 番目"]);
  });

  it("3 種の種別が入る", async () => {
    const { body } = await detail(runKeyOf(1));

    expect(new Set(body.timeline.map((entry) => entry.kind))).toEqual(
      new Set(["ask", "event", "inbox"]),
    );
  });

  /** 他の run の行は混ぜない。 */
  it("別の run の行は入らない", async () => {
    await seedRun({ runKey: runKeyOf(2), projectId: alpha, threadId: null });
    await seedEvent({
      runKey: runKeyOf(2),
      kind: "progress",
      body: "別の run",
    });

    const { body } = await detail(runKeyOf(1));

    expect(body.timeline).toHaveLength(4);
    expect(JSON.stringify(body.timeline)).not.toContain("別の run");
  });

  it("何も無ければ空の時系列", async () => {
    await seedRun({ runKey: runKeyOf(5), projectId: alpha, threadId: null });

    expect((await detail(runKeyOf(5))).body.timeline).toEqual([]);
  });
});

describe("時系列の 1 行の中身", () => {
  beforeEach(async () => {
    await seedRun({ runKey: runKeyOf(1), projectId: alpha });
  });

  it("問いは選択肢と回答の状態を持つ", async () => {
    await seedAsk({
      askId: askIdOf(1),
      runKey: runKeyOf(1),
      question: "どちらに倒しますか",
      options: ["A 案", "B 案"],
      answer: "B 案",
      answeredAt: NOW,
      deliveredAt: NOW + 1,
    });

    const entry = (await detail(runKeyOf(1))).body.timeline[0];

    expect(entry).toMatchObject({
      kind: "ask",
      question: "どちらに倒しますか",
      options: ["A 案", "B 案"],
      answer: "B 案",
    });
  });

  /** 壊れた `options` で詳細が丸ごと落ちない（`packages/db` の `parseOptions`）。 */
  it("options が壊れていても落ちずに空配列になる", async () => {
    await seedAsk({
      askId: askIdOf(1),
      runKey: runKeyOf(1),
      question: "?",
      options: [],
    });
    await env.DB.prepare(`UPDATE asks SET options = '[1, "a", null]'`).run();

    const entry = (await detail(runKeyOf(1))).body.timeline[0];

    expect(entry).toMatchObject({ kind: "ask", options: ["a"] });
  });

  it("event は Discord のメッセージ id を持つ（無ければ null）", async () => {
    await seedEvent({
      runKey: runKeyOf(1),
      kind: "blocked",
      body: "詰まりました",
      discordMessageId: null,
    });

    expect((await detail(runKeyOf(1))).body.timeline[0]).toMatchObject({
      kind: "event",
      eventKind: "blocked",
      discordMessageId: null,
    });
  });

  /** `taken_by_run_key` は「どの実行に渡ったか」（テーブル定義書 §4-6）。 */
  it("素の文は渡した先の run を持つ", async () => {
    await seedInbox({
      runKey: runKeyOf(1),
      body: "あとで見ます",
      takenAt: NOW,
      takenByRunKey: runKeyOf(1),
    });

    expect((await detail(runKeyOf(1))).body.timeline[0]).toMatchObject({
      kind: "inbox",
      takenByRunKey: runKeyOf(1),
    });
  });
});

describe("コンテキスト残量", () => {
  it("通報が来ていなければ null と既定の窓", async () => {
    await seedRun({ runKey: runKeyOf(1), projectId: alpha, ctx: null });

    const { body } = await detail(runKeyOf(1));

    expect(body.contextPercent).toBeNull();
    expect(body.contextUsedTokens).toBeNull();
    expect(body.contextAt).toBeNull();
    expect(body.contextWindowTokens).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    expect(body.contextWindowKnown).toBe(false);
  });

  it("知っているモデルなら窓が引ける", async () => {
    await seedRun({
      runKey: runKeyOf(1),
      projectId: alpha,
      ctx: { usedTokens: 250_000, at: NOW, model: "claude-opus-5" },
    });

    const { body } = await detail(runKeyOf(1));

    expect(body.contextWindowTokens).toBe(1_000_000);
    expect(body.contextWindowKnown).toBe(true);
    expect(body.contextPercent).toBe(25);
    expect(body.contextModel).toBe("claude-opus-5");
  });

  /*
    **知らないモデルは「分からない」と言う。** 200k を仮の分母にするが、
    `contextWindowKnown: false` を返すので画面が「分母は仮」と添えられる
    （要件 `F-D4`「黙って既定値に倒さない」）。
  */
  it("知らないモデルは窓を引けていないと返す", async () => {
    await seedRun({
      runKey: runKeyOf(1),
      projectId: alpha,
      ctx: { usedTokens: 50_000, at: NOW, model: "claude-unknown-9" },
    });

    const { body } = await detail(runKeyOf(1));

    expect(body.contextWindowTokens).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    expect(body.contextWindowKnown).toBe(false);
    expect(body.contextPercent).toBe(25);
  });

  /** 角括弧の変種（`claude-opus-5[1m]`）も引ける。 */
  it("長い窓の変種も引ける", async () => {
    await seedRun({
      runKey: runKeyOf(1),
      projectId: alpha,
      ctx: { usedTokens: 100_000, at: NOW, model: "claude-opus-5[1m]" },
    });

    expect((await detail(runKeyOf(1))).body.contextWindowTokens).toBe(
      1_000_000,
    );
  });
});

describe("詰まりの切り分けに要る列", () => {
  /*
    **`held_at` と `activity_at` は別の意味**（テーブル定義書 §4-3）。
    片方だけを返すと「握りは死んだが Claude は生きている」が読めなくなる。
  */
  it("握りのハートビートと Claude の信号を両方返す", async () => {
    await seedRun({
      runKey: runKeyOf(1),
      projectId: alpha,
      heldAt: NOW - 5000,
      activityAt: NOW - 1000,
    });

    const { body } = await detail(runKeyOf(1));

    expect(body.heldAt).toBe(NOW - 5000);
    expect(body.activityAt).toBe(NOW - 1000);
  });

  it("失敗の理由を返す", async () => {
    await seedRun({
      runKey: runKeyOf(1),
      projectId: alpha,
      status: "failed",
      failureReason: "fire が 401 を返しました",
    });

    const { body } = await detail(runKeyOf(1));

    expect(body.status).toBe("failed");
    expect(body.failureReason).toBe("fire が 401 を返しました");
    expect(body.finishedAt).not.toBeNull();
  });

  it("終わっていなければ finishedAt は null", async () => {
    await seedRun({ runKey: runKeyOf(1), projectId: alpha, status: "running" });

    expect((await detail(runKeyOf(1))).body.finishedAt).toBeNull();
  });
});
