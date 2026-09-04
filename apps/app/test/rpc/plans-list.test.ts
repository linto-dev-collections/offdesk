import { env } from "cloudflare:workers";
import type { PlanListOutput } from "@offdesk/contract";
import { PLAN_LIST_LIMIT } from "@offdesk/usecase";
import { beforeEach, describe, expect, it } from "vitest";
import { signIn } from "../auth/support.ts";
import { seedTwoProjects } from "../db/support.ts";
import { callRpc, rpcJson, runKeyOf, seedRun } from "./support.ts";

/*
  計画一覧（要件 `F-F` の「計画一覧」・計画 P7b §3-1・§5）。

  **R2 は触らない。** 一覧が出すのは台帳の控え（`file_count` / `total_bytes`）で、
  R2 を引くのは閲覧のときだけ —— 置いてから引く経路は
  `test/plans/idempotent.test.ts` が別に固めている。
*/

const NOW = Date.now();
const MINUTE = 60_000;

let alpha = "";
let authed = new Headers();

beforeEach(async () => {
  alpha = (await seedTwoProjects()).alpha;
  authed = (await signIn()).headers;
});

const seedPlan = async (input: {
  readonly planId: string;
  readonly scopeKind: "thread" | "run";
  readonly scopeId: string;
  readonly slug: string;
  readonly runKey: string;
  readonly fileCount?: number;
  readonly totalBytes?: number;
  readonly updatedAt?: number;
}): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO plans (plan_id, scope_kind, scope_id, slug, last_published_run_key,
                        file_count, total_bytes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      input.planId,
      input.scopeKind,
      input.scopeId,
      input.slug,
      input.runKey,
      input.fileCount ?? 1,
      input.totalBytes ?? 1024,
      input.updatedAt ?? NOW,
      input.updatedAt ?? NOW,
    )
    .run();
};

const list = async () =>
  await rpcJson<PlanListOutput>("plans/list", {}, authed);

describe("POST /rpc/plans.list", () => {
  it("未ログインなら 401", async () => {
    expect((await callRpc("plans/list", {})).status).toBe(401);
  });

  it("台帳が空でも枠は返る", async () => {
    const { status, body } = await list();

    expect(status).toBe(200);
    expect(body).toEqual({ items: [] });
  });

  it("1 行の形がそろっている", async () => {
    const runKey = await seedRun({
      runKey: runKeyOf(1),
      projectId: alpha,
      threadId: "444444444444444444",
    });
    await seedPlan({
      planId: "a".repeat(32),
      scopeKind: "thread",
      scopeId: "444444444444444444",
      slug: "phase-07b",
      runKey,
      fileCount: 3,
      totalBytes: 231_647,
    });

    const { body } = await list();

    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      planId: "a".repeat(32),
      scopeKind: "thread",
      scopeLabel: "444444444444444444",
      slug: "phase-07b",
      fileCount: 3,
      totalBytes: 231_647,
      lastPublishedRunKey: runKey,
    });
  });

  /** **`/p/<planId>/`**（末尾のスラッシュ込み。計画 P6 §4-4）。 */
  it("viewUrl が /p/<planId>/ の形", async () => {
    const runKey = await seedRun({ runKey: runKeyOf(1), projectId: alpha });
    await seedPlan({
      planId: "b".repeat(32),
      scopeKind: "run",
      scopeId: runKey,
      slug: "phase-01",
      runKey,
    });

    const { body } = await list();

    expect(body.items[0]?.viewUrl).toBe(`/p/${"b".repeat(32)}/`);
  });

  /*
    **スレッドのリンクは `DISCORD_GUILD_ID` から組む**（P7a §10-1）。
    テストの env には値が入っているので、ここでは組めた形を見る。
  */
  it("thread スコープなら Discord のリンクが付く", async () => {
    const runKey = await seedRun({
      runKey: runKeyOf(1),
      projectId: alpha,
      threadId: "444444444444444444",
    });
    await seedPlan({
      planId: "c".repeat(32),
      scopeKind: "thread",
      scopeId: "444444444444444444",
      slug: "phase-07b",
      runKey,
    });

    const { body } = await list();

    expect(body.items[0]?.scopeUrl).toBe(
      `https://discord.com/channels/${env.DISCORD_GUILD_ID}/444444444444444444`,
    );
  });

  /** スレッドを立てられなかった run の計画（要件 `F-A7`）。リンクは無い。 */
  it("run スコープなら scopeUrl は null", async () => {
    const runKey = await seedRun({ runKey: runKeyOf(1), projectId: alpha });
    await seedPlan({
      planId: "d".repeat(32),
      scopeKind: "run",
      scopeId: runKey,
      slug: "phase-01",
      runKey,
    });

    const { body } = await list();

    expect(body.items[0]?.scopeUrl).toBeNull();
    expect(body.items[0]?.scopeLabel).toBe(runKey);
  });

  /** **新しい順**（`plans_updated_idx`）。貼ったリンクを見失って探すのが用途。 */
  it("最終更新の新しい順に並ぶ", async () => {
    const runKey = await seedRun({ runKey: runKeyOf(1), projectId: alpha });
    await seedPlan({
      planId: "1".repeat(32),
      scopeKind: "run",
      scopeId: runKey,
      slug: "old",
      runKey,
      updatedAt: NOW - 10 * MINUTE,
    });
    await seedPlan({
      planId: "2".repeat(32),
      scopeKind: "thread",
      scopeId: "444444444444444444",
      slug: "new",
      runKey,
      updatedAt: NOW,
    });

    const { body } = await list();

    expect(body.items.map((item) => item.slug)).toEqual(["new", "old"]);
  });

  /*
    **控えをそのまま出す**（計画 P7b §3-1・§7）。R2 と数が合わないのは
    `finish` が途中で失敗した合図なので、直さずに見せる。
  */
  it("R2 に何も無くても控えの数を出す", async () => {
    const runKey = await seedRun({ runKey: runKeyOf(1), projectId: alpha });
    await seedPlan({
      planId: "e".repeat(32),
      scopeKind: "run",
      scopeId: runKey,
      slug: "phase-01",
      runKey,
      fileCount: 7,
      totalBytes: 999,
    });

    const { body } = await list();

    expect(body.items[0]).toMatchObject({ fileCount: 7, totalBytes: 999 });
  });

  /** 上限を持つ（`packages/usecase` の定数）。**上限が無いクエリを 1 本も置かない。** */
  it("上限は packages/usecase の定数と同じ", () => {
    expect(PLAN_LIST_LIMIT).toBe(200);
  });
});
