import type { RunListOutput } from "@offdesk/contract";
import { RUN_PAGE_SIZE, RUN_PROMPT_PREVIEW_LENGTH } from "@offdesk/usecase";
import { beforeEach, describe, expect, it } from "vitest";
import { signIn } from "../auth/support.ts";
import { seedTwoProjects } from "../db/support.ts";
import { callRpc, rpcJson, runKeyOf, seedRun } from "./support.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

let alpha = "";
let beta = "";
let authed = new Headers();

/*
  **ログインは 1 テストに 1 回**（`signIn` は `users` に行を入れるので、
  2 回呼ぶと `users.email` の UNIQUE に落ちる）。
*/
beforeEach(async () => {
  const projects = await seedTwoProjects();
  alpha = projects.alpha;
  beta = projects.beta;
  authed = (await signIn()).headers;
});

const list = async (input: unknown = {}) =>
  await rpcJson<RunListOutput>("runs/list", input, authed);

describe("POST /rpc/runs.list", () => {
  it("未ログインなら 401", async () => {
    expect((await callRpc("runs/list", {})).status).toBe(401);
  });

  it("台帳が空なら 0 件（画面としては正しい）", async () => {
    const { status, body } = await list();

    expect(status).toBe(200);
    expect(body).toEqual({
      items: [],
      total: 0,
      page: 1,
      pageSize: RUN_PAGE_SIZE,
    });
  });

  it("プロジェクト名が入って返る", async () => {
    await seedRun({ runKey: runKeyOf(1), projectId: alpha });

    const { body } = await list();

    expect(body.items[0]?.projectName).toBe("offdesk-test");
  });
});

describe("絞り込み", () => {
  beforeEach(async () => {
    await seedRun({
      runKey: runKeyOf(1),
      projectId: alpha,
      status: "running",
      createdAt: Date.now() - 1000,
    });
    await seedRun({
      runKey: runKeyOf(2),
      projectId: beta,
      status: "done",
      createdAt: Date.now() - 2000,
    });
    await seedRun({
      runKey: runKeyOf(3),
      projectId: alpha,
      status: "failed",
      createdAt: Date.now() - 3000,
    });
  });

  it("プロジェクトで絞れる", async () => {
    const { body } = await list({ projectId: alpha });

    expect(body.total).toBe(2);
    expect(body.items.map((item) => item.runKey)).toEqual([
      runKeyOf(1),
      runKeyOf(3),
    ]);
  });

  it("状態で絞れる", async () => {
    const { body } = await list({ status: "done" });

    expect(body.items.map((item) => item.runKey)).toEqual([runKeyOf(2)]);
  });

  it("プロジェクトと状態を重ねられる", async () => {
    const { body } = await list({ projectId: alpha, status: "failed" });

    expect(body.items.map((item) => item.runKey)).toEqual([runKeyOf(3)]);
  });

  it("在らないプロジェクト id なら 0 件（SQL は落ちない）", async () => {
    const { status, body } = await list({ projectId: "no-such-project" });

    expect(status).toBe(200);
    expect(body.total).toBe(0);
  });

  /** 期間は「何日前から」。既定の 30 日より古い run は出ない。 */
  it("期間の外の run は出ない", async () => {
    await seedRun({
      runKey: runKeyOf(9),
      projectId: alpha,
      createdAt: Date.now() - 40 * DAY_MS,
    });

    expect((await list()).body.total).toBe(3);
    expect((await list({ sinceDays: 365 })).body.total).toBe(4);
  });

  it("総数は絞り込みと同じ条件で数える", async () => {
    const { body } = await list({ status: "running" });

    expect(body.total).toBe(1);
    expect(body.items).toHaveLength(1);
  });
});

describe("ページング", () => {
  const TOTAL = RUN_PAGE_SIZE + 10;

  beforeEach(async () => {
    const base = Date.now() - TOTAL * 1000;
    for (let index = 1; index <= TOTAL; index += 1) {
      await seedRun({
        runKey: runKeyOf(index),
        projectId: alpha,
        createdAt: base + index * 1000,
      });
    }
  });

  it("1 ページは 50 件で、総数は全件", async () => {
    const { body } = await list();

    expect(body.items).toHaveLength(RUN_PAGE_SIZE);
    expect(body.total).toBe(TOTAL);
    expect(body.pageSize).toBe(RUN_PAGE_SIZE);
  });

  it("2 ページ目に残りが出る", async () => {
    const { body } = await list({ page: 2 });

    expect(body.items).toHaveLength(TOTAL - RUN_PAGE_SIZE);
    expect(body.page).toBe(2);
  });

  /*
    **総数を超えるページは空で返す**（最終ページへ飛ばさない）。
    勝手に飛ばすと、URL を共有した相手が別のものを見る。
  */
  it("総数を超えるページは空", async () => {
    const { body } = await list({ page: 99 });

    expect(body.items).toEqual([]);
    expect(body.page).toBe(99);
    expect(body.total).toBe(TOTAL);
  });

  it("ページをまたいで重複しない", async () => {
    const first = (await list()).body.items.map((item) => item.runKey);
    const second = (await list({ page: 2 })).body.items.map(
      (item) => item.runKey,
    );

    expect(new Set([...first, ...second]).size).toBe(TOTAL);
  });
});

describe("並び替え（plans/security.md 脅威 11）", () => {
  beforeEach(async () => {
    const now = Date.now();
    // 作成の順と更新の順を**逆**にする。allowlist が効いていないと見分けが付かない。
    await seedRun({
      runKey: runKeyOf(1),
      projectId: alpha,
      createdAt: now - 3000,
      updatedAt: now - 1000,
    });
    await seedRun({
      runKey: runKeyOf(2),
      projectId: alpha,
      createdAt: now - 2000,
      updatedAt: now - 2000,
    });
    await seedRun({
      runKey: runKeyOf(3),
      projectId: alpha,
      createdAt: now - 1000,
      updatedAt: now - 3000,
    });
  });

  it("既定は作成の新しい順", async () => {
    expect((await list()).body.items.map((item) => item.runKey)).toEqual([
      runKeyOf(3),
      runKeyOf(2),
      runKeyOf(1),
    ]);
  });

  it("作成の古い順にできる", async () => {
    const { body } = await list({ sort: "createdAt", order: "asc" });

    expect(body.items.map((item) => item.runKey)).toEqual([
      runKeyOf(1),
      runKeyOf(2),
      runKeyOf(3),
    ]);
  });

  it("更新の新しい順にできる", async () => {
    const { body } = await list({ sort: "updatedAt", order: "desc" });

    expect(body.items.map((item) => item.runKey)).toEqual([
      runKeyOf(1),
      runKeyOf(2),
      runKeyOf(3),
    ]);
  });

  /*
    **allowlist の外は既定値へ倒れる。** 400 にはしない（`RunListQuery` の
    全フィールドが `.catch()` を持つ ＝ URL の検証と同じ 1 本だから）が、
    **受け取った文字列が `ORDER BY` に届かない**ことは変わらない ——
    届いていれば `prompt` 順になるか、SQL の構文で 500 になる。
  */
  it.each([
    "prompt",
    "run_key",
    "created_at",
    "created_at; DROP TABLE runs",
    "createdAt) --",
    "1",
  ])("sort=%s は既定値に倒れる（SQL に届かない）", async (sort) => {
    const { status, body } = await list({ sort });

    expect(status).toBe(200);
    expect(body.items.map((item) => item.runKey)).toEqual([
      runKeyOf(3),
      runKeyOf(2),
      runKeyOf(1),
    ]);
  });

  it("order の allowlist 外も既定値に倒れる", async () => {
    const { status, body } = await list({ order: "asc; DROP TABLE runs" });

    expect(status).toBe(200);
    expect(body.items[0]?.runKey).toBe(runKeyOf(3));
  });

  it("表がまだ在ることを確かめる（DROP が通っていない）", async () => {
    await list({ sort: "created_at; DROP TABLE runs" });

    expect((await list()).body.total).toBe(3);
  });

  /** 画面側では残る知らないキーが、ここで落ちる（`test/client/search-params.test.ts`）。 */
  it("知らないキーは落として 200", async () => {
    const { status, body } = await list({ nope: 1, page: 1 });

    expect(status).toBe(200);
    expect(body.total).toBe(3);
  });

  it("不正な page でも 400 にせず 1 ページ目を返す", async () => {
    const { status, body } = await list({ page: "abc" });

    expect(status).toBe(200);
    expect(body.page).toBe(1);
  });
});

describe("1 行の中身", () => {
  /** 一覧に全文を出さない（plans/security.md 脅威 12）。 */
  it("prompt は 120 字に切られ、切った印が立つ", async () => {
    await seedRun({
      runKey: runKeyOf(1),
      projectId: alpha,
      prompt: "あ".repeat(300),
    });

    const item = (await list()).body.items[0];

    expect(item?.prompt).toHaveLength(RUN_PROMPT_PREVIEW_LENGTH);
    expect(item?.prompt.endsWith("…")).toBe(true);
    expect(item?.promptTruncated).toBe(true);
  });

  it("短い prompt はそのまま（印も立たない）", async () => {
    await seedRun({ runKey: runKeyOf(1), projectId: alpha, prompt: "ping" });

    const item = (await list()).body.items[0];

    expect(item?.prompt).toBe("ping");
    expect(item?.promptTruncated).toBe(false);
  });

  /** 改行を潰してから切る（表の 1 行が縦に伸びない）。 */
  it("改行は空白に潰れる", async () => {
    await seedRun({
      runKey: runKeyOf(1),
      projectId: alpha,
      prompt: "1 行目\n\n2 行目",
    });

    expect((await list()).body.items[0]?.prompt).toBe("1 行目 2 行目");
  });

  it("スレッドが無ければ threadUrl は null", async () => {
    await seedRun({ runKey: runKeyOf(1), projectId: alpha, threadId: null });

    expect((await list()).body.items[0]?.threadUrl).toBeNull();
  });

  /** `DISCORD_GUILD_ID` はテストの設定で `999999999999999999`。 */
  it("スレッドがあれば Discord の URL が入る", async () => {
    await seedRun({
      runKey: runKeyOf(1),
      projectId: alpha,
      threadId: "444444444444444444",
    });

    expect((await list()).body.items[0]?.threadUrl).toBe(
      "https://discord.com/channels/999999999999999999/444444444444444444",
    );
  });

  it("残量の通報が来ていなければ contextPercent は null", async () => {
    await seedRun({ runKey: runKeyOf(1), projectId: alpha, ctx: null });

    expect((await list()).body.items[0]?.contextPercent).toBeNull();
  });

  /** 既定の窓は 200k（要件 `F-D4`）。50k なら 25%。 */
  it("モデルが分からなければ 200k を分母にする", async () => {
    await seedRun({
      runKey: runKeyOf(1),
      projectId: alpha,
      ctx: { usedTokens: 50_000, at: Date.now(), model: null },
    });

    expect((await list()).body.items[0]?.contextPercent).toBe(25);
  });

  /** `claude-sonnet-5` は native で 1M。50k なら 5%。 */
  it("モデルが分かればその窓を分母にする", async () => {
    await seedRun({
      runKey: runKeyOf(1),
      projectId: alpha,
      ctx: { usedTokens: 50_000, at: Date.now(), model: "claude-sonnet-5" },
    });

    expect((await list()).body.items[0]?.contextPercent).toBe(5);
  });

  /** 100 を超えても丸めない（要件 `F-D4`「203% は隠さない」）。 */
  it("分母を超えていればそのまま 100 超えで返す", async () => {
    await seedRun({
      runKey: runKeyOf(1),
      projectId: alpha,
      ctx: { usedTokens: 406_000, at: Date.now(), model: null },
    });

    expect((await list()).body.items[0]?.contextPercent).toBe(203);
  });

  /*
    **一覧に秘密が出ない**（plans/security.md 脅威 12・要件 `F-F3`）。
    `cc_session_url` は詳細だけ。fire の URL とトークンはどこにも出ない。
  */
  it("応答に fire の URL もトークンも cc セッションも無い", async () => {
    await seedRun({
      runKey: runKeyOf(1),
      projectId: alpha,
      ccSession: { id: "sess", url: "https://claude.ai/session/secret" },
    });
    const text = await (await callRpc("runs/list", {}, authed)).text();

    expect(text).not.toContain("trig_");
    expect(text).not.toContain("sk-ant");
    expect(text).not.toContain("ciphertext");
    expect(text).not.toContain("claude.ai/session");
  });
});
