import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CHANNEL_BETA,
  seedProject,
  seedRun,
  THREAD_ID,
} from "../db/support.ts";
import {
  planRow,
  publish,
  RUN,
  seedPublisher,
  storedPaths,
} from "./support.ts";

/*
  同じ URL に上書きされること（要件 `F-E4`・`I-6`・計画 P6 §6）。

  **これが `plan_id` を持っている理由。** Discord に貼ったリンクが古い版を
  指し続けると、依頼者は「直したと言われたのに直っていない」を見る ——
  kanata で実際に起きていた壊れ方。
*/

const OTHER_RUN = "OFFDESK-2222222222222222";

beforeEach(async () => {
  await seedPublisher();
});

describe("同じスレッドの同じ名前", () => {
  it("2 回置いても URL が同じ", async () => {
    const first = await publish({ files: { "README.md": "1" } });
    const second = await publish({ files: { "README.md": "22" } });

    expect(second.planId).toBe(first.planId);
    expect(new URL(second.url).pathname).toBe(new URL(first.url).pathname);
  });

  it("控えが置き直しで更新される", async () => {
    const { planId } = await publish({ files: { "README.md": "1" } });
    expect(await planRow(planId)).toMatchObject({
      file_count: 1,
      total_bytes: 1,
    });

    await publish({ files: { "README.md": "12345", "next.md": "67" } });

    expect(await planRow(planId)).toMatchObject({
      file_count: 2,
      total_bytes: 7,
    });
  });

  it("台帳の行は 1 本だけ", async () => {
    await publish({ files: { "README.md": "1" } });
    await publish({ files: { "README.md": "2" } });

    const row = await env.DB.prepare("SELECT count(*) AS n FROM plans").first<{
      n: number;
    }>();

    expect(row?.n).toBe(1);
  });

  /*
    **これが `I-6` の本体。** run が落ちて `restart` で `run_key` が変わっても、
    スレッドが同じなら同じ URL に上書きされる。`plan_id` の元が `run_key` だと、
    直すたびに URL が変わる。
  */
  it("run_key が変わっても同じ URL（起こし直し）", async () => {
    const first = await publish({ files: { "README.md": "1" } });

    // 前の run を畳んで、同じスレッドに新しい run を立てる（P4 の restart と同じ形）。
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE runs SET status = 'abandoned', finished_at = ? WHERE run_key = ?",
      ).bind(Date.now(), RUN),
      env.DB.prepare(
        `INSERT INTO runs (run_key, project_id, prompt, status,
                           requester_discord_user_id, channel_id, thread_id)
         SELECT ?, project_id, prompt, 'running', requester_discord_user_id,
                channel_id, thread_id
         FROM runs WHERE run_key = ?`,
      ).bind(OTHER_RUN, RUN),
    ]);

    const second = await publish({
      files: { "README.md": "2" },
      runKey: OTHER_RUN,
    });

    expect(second.planId).toBe(first.planId);
    expect(await planRow(first.planId)).toMatchObject({
      scope_kind: "thread",
      scope_id: THREAD_ID,
      last_published_run_key: OTHER_RUN,
    });
  });

  it("名前が違えば別の URL", async () => {
    const a = await publish({ slug: "github-link", files: { "a.md": "1" } });
    const b = await publish({ slug: "phase-06", files: { "a.md": "1" } });

    expect(b.planId).not.toBe(a.planId);
  });

  /** 置き場も分かれている（片方を消してももう片方が残る）。 */
  it("名前が違えば R2 の置き場も分かれる", async () => {
    const a = await publish({ slug: "github-link", files: { "a.md": "1" } });
    const b = await publish({ slug: "phase-06", files: { "b.md": "1" } });

    expect(await storedPaths(a.planId)).toEqual(["a.md"]);
    expect(await storedPaths(b.planId)).toEqual(["b.md"]);
  });
});

describe("スレッドが無い run", () => {
  /** 要件 `F-A7` の「スレッドを立てられなかった」run。scope は run に落ちる。 */
  it("scope_kind が run になる", async () => {
    const projectId = await seedProject({
      name: "beta",
      discordChannelId: CHANNEL_BETA,
    });
    const runKey = await seedRun({
      projectId,
      runKey: OTHER_RUN,
      threadId: null,
    });

    const { planId } = await publish({
      files: { "README.md": "1" },
      runKey,
    });

    expect(await planRow(planId)).toMatchObject({
      scope_kind: "run",
      scope_id: OTHER_RUN,
    });
  });

  /*
    **スレッドが無い run どうしは別の計画になる。** 同じ名前でも run が違えば
    別の URL —— スレッドが無いのだから「同じ場所」と言える手掛かりがない。
  */
  it("別の run なら同じ名前でも別の URL", async () => {
    const projectId = await seedProject({
      name: "beta",
      discordChannelId: CHANNEL_BETA,
    });
    await seedRun({ projectId, runKey: OTHER_RUN, threadId: null });
    await seedRun({
      projectId,
      runKey: "OFFDESK-3333333333333333",
      threadId: null,
    });

    const a = await publish({ files: { "a.md": "1" }, runKey: OTHER_RUN });
    const b = await publish({
      files: { "a.md": "1" },
      runKey: "OFFDESK-3333333333333333",
    });

    expect(b.planId).not.toBe(a.planId);
  });
});
