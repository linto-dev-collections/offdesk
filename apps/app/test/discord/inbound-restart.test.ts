import { env } from "cloudflare:workers";
import type { InboundMessage } from "@offdesk/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyInbound } from "../../src/worker/discord/inbound.ts";
import { MARK_HANDED, MARK_SEEN } from "../../src/worker/discord/marks.ts";
import {
  CHANNEL_ALPHA,
  inboxRows,
  runRows,
  seedProject,
  seedRun,
  seedTwoProjects,
  THREAD_ID,
} from "../db/support.ts";
import {
  discordOk,
  jsonResponse,
  type OutboundStub,
  type RouteHandler,
  stubOutbound,
} from "../support/outbound.ts";
import { OWNER_ID } from "./support.ts";

const NEW_RUN_PATTERN = /^OFFDESK-[0-9a-f]{16}$/;

let projectId: string;
let stub: OutboundStub;

const fireOk: RouteHandler = () =>
  jsonResponse({
    claude_code_session_id: "session_01restart",
    claude_code_session_url: "https://claude.ai/code/session_01restart",
  });

const setStub = (fire: RouteHandler): void => {
  stub = stubOutbound([
    ["discord.com", discordOk({ messageId: "888888888888888888" })],
    ["api.anthropic.com", fire],
  ]);
};

beforeEach(async () => {
  const { alpha } = await seedTwoProjects();
  projectId = alpha;
  setStub(fireOk);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const message = (overrides: Partial<InboundMessage> = {}): InboundMessage => ({
  messageId: "777777777777777777",
  channelId: THREAD_ID,
  authorId: OWNER_ID,
  authorIsBot: false,
  content: "つづきをお願い",
  ...overrides,
});

const deliver = (overrides: Partial<InboundMessage> = {}) =>
  applyInbound(env, message(overrides));

const reactionCalls = (emoji: string) =>
  stub.callsTo(`/reactions/${encodeURIComponent(emoji)}/@me`);

const firedText = (): string => {
  const [fire] = stub.callsTo("api.anthropic.com");
  const body = JSON.parse(fire?.body ?? "{}") as { text?: string };
  return body.text ?? "";
};

const seedFinished = async (
  queued: readonly string[] = [],
  status = "done",
): Promise<string> => {
  const runKey = await seedRun({ projectId, status });

  for (const [index, body] of queued.entries()) {
    await env.DB.prepare(
      `INSERT INTO inbox (run_key, author_discord_user_id, message_id, body)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(runKey, OWNER_ID, `66666666666666666${index}`, body)
      .run();
  }

  return runKey;
};

describe("終わっている run のスレッドに書いたとき", () => {
  it("前の run が abandoned になり、新しい run が同じスレッドに立つ", async () => {
    const previous = await seedRun({ projectId, status: "done" });

    const outcome = await deliver();

    expect(outcome.decision).toBe("restart");
    expect(outcome.runKey).toMatch(NEW_RUN_PATTERN);

    const rows = await runRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ run_key: previous, status: "done" });
    expect(rows[1]).toMatchObject({
      run_key: outcome.runKey,
      status: "running",
      thread_id: THREAD_ID,
      channel_id: CHANNEL_ALPHA,
    });
  });

  it("落ちている（生きているが古い）run は abandoned になる", async () => {
    const previous = await seedRun({
      projectId,
      status: "running",
      heldAt: Date.now() - 10_000,
    });
    await env.DB.prepare("UPDATE runs SET created_at = ? WHERE run_key = ?")
      .bind(Date.now() - 60_000, previous)
      .run();

    const outcome = await deliver();

    expect(outcome.decision).toBe("restart");
    const rows = await runRows();
    expect(rows[0]).toMatchObject({ run_key: previous, status: "abandoned" });
    expect(rows[0]?.failure_reason).toBe("素の文で起こし直したため");
    expect(rows[0]?.finished_at).not.toBeNull();
  });

  it("同じスレッドに生きている run が 1 本しか残らない", async () => {
    await seedRun({
      projectId,
      status: "running",
      heldAt: Date.now() - 10_000,
    });
    await env.DB.prepare("UPDATE runs SET created_at = ? WHERE thread_id = ?")
      .bind(Date.now() - 60_000, THREAD_ID)
      .run();

    await deliver();

    const live = (await runRows()).filter((row) =>
      ["queued", "running", "waiting"].includes(row.status),
    );
    expect(live).toHaveLength(1);
  });

  it("cc_session_id と cc_session_url が対で入る", async () => {
    await seedFinished();

    await deliver();

    const [, next] = await runRows();
    expect(next?.cc_session_id).toBe("session_01restart");
    expect(next?.cc_session_url).toBe(
      "https://claude.ai/code/session_01restart",
    );
  });

  it("起こし直したことをスレッドへ出す", async () => {
    await seedFinished();

    const outcome = await deliver();

    const posts = stub.callsTo(`/channels/${THREAD_ID}/messages`);
    const bodies = posts.map(
      (post) => (JSON.parse(post.body ?? "{}") as { content?: string }).content,
    );
    expect(bodies.join("\n")).toContain("起こし直しました");
    expect(bodies.join("\n")).toContain(outcome.runKey ?? "");
  });
});

describe("作業対象をスレッド名から拾い直す", () => {
  const withThreadName = (name: string): void => {
    stub = stubOutbound([
      [
        "discord.com",
        (call) => {
          if (
            call.method === "GET" &&
            call.url.endsWith(`/channels/${THREAD_ID}`)
          ) {
            return jsonResponse({ id: THREAD_ID, name });
          }
          return discordOk({ messageId: "888888888888888888" })(call);
        },
      ],
      ["api.anthropic.com", fireOk],
    ]);
  };

  it("Issue のスレッドなら同じブランチを指定し直す", async () => {
    withThreadName("OFFDESK #123 READMEを直す");
    await seedFinished();

    await deliver();

    expect(firedText()).toContain("claude/issue-123");
  });

  it("PR のスレッドならブランチを作らせない", async () => {
    withThreadName("OFFDESK PR#45 レビューして");
    await seedFinished();

    await deliver();

    expect(firedText()).toContain("Pull Request #45");
    expect(firedText()).not.toContain("claude/");
  });

  it("名前を読めなくても起こし直しは通る", async () => {
    await seedFinished();

    const outcome = await deliver();

    expect(outcome.runKey).toMatch(NEW_RUN_PATTERN);
    expect(firedText()).toContain("対応する Issue や PR の指定はありません");
  });
});

describe("溜めていた分も一緒に渡す", () => {
  it("3 行が 1 つに畳まれて渡る", async () => {
    await seedFinished(["1 行目", "2 行目", "3 行目"]);

    await deliver({ content: "4 行目" });

    const text = firedText();
    for (const body of ["1 行目", "2 行目", "3 行目", "4 行目"]) {
      expect(text).toContain(body);
    }
    expect(stub.callsTo("api.anthropic.com")).toHaveLength(1);
  });

  it("古い順に並ぶ", async () => {
    await seedFinished(["さいしょ", "つぎ"]);

    await deliver({ content: "さいご" });

    const text = firedText();
    expect(text.indexOf("さいしょ")).toBeLessThan(text.indexOf("つぎ"));
    expect(text.indexOf("つぎ")).toBeLessThan(text.indexOf("さいご"));
  });

  it("run_key が 1 行目に載る（buildFireText と同じ形）", async () => {
    await seedFinished();

    const outcome = await deliver();

    expect(firedText().split("\n")[0]).toBe(outcome.runKey);
  });

  it("taken_by_run_key に新しい run が入る", async () => {
    const previous = await seedFinished(["前に書いた分"]);

    const outcome = await deliver();

    const rows = await inboxRows();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.run_key).toBe(previous);
      expect(row.taken_by_run_key).toBe(outcome.runKey);
      expect(row.taken_at).not.toBeNull();
    }
  });

  it("渡した全部の 👀 が ✅ に付け替わる", async () => {
    await seedFinished(["前に書いた分"]);

    await deliver();

    expect(reactionCalls(MARK_HANDED)).toHaveLength(2);
    expect(reactionCalls(MARK_HANDED)[0]?.method).toBe("PUT");
    expect(
      reactionCalls(MARK_SEEN).filter((call) => call.method === "DELETE"),
    ).toHaveLength(2);
  });
});

describe("起動に失敗したとき（印を立てない）", () => {
  const seedFailing = async (queued: readonly string[]) => {
    const runKey = await seedFinished(queued);
    setStub(() => jsonResponse({ error: "nope" }, 500));
    return runKey;
  };

  it("taken_at が立たない（文が宙に浮かない）", async () => {
    await seedFailing(["前に書いた分"]);

    await deliver();

    const rows = await inboxRows();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.taken_at).toBeNull();
      expect(row.taken_by_run_key).toBeNull();
    }
  });

  it("✅ も付かない", async () => {
    await seedFailing(["前に書いた分"]);

    await deliver();

    expect(reactionCalls(MARK_HANDED)).toEqual([]);
  });

  it("新しい run は failed に畳まれる", async () => {
    await seedFailing([]);

    const outcome = await deliver();

    const [, next] = await runRows();
    expect(next?.run_key).toBe(outcome.runKey);
    expect(next?.status).toBe("failed");
    expect(next?.finished_at).not.toBeNull();
  });

  it("起こし直せなかったことをスレッドへ出す", async () => {
    await seedFailing([]);

    await deliver();

    const bodies = stub
      .callsTo(`/channels/${THREAD_ID}/messages`)
      .map(
        (post) =>
          (JSON.parse(post.body ?? "{}") as { content?: string }).content ?? "",
      );
    expect(bodies.join("\n")).toContain("起こし直せませんでした");
    expect(bodies.join("\n")).toContain("預かったまま");
  });

  it("直したあとの 1 行で全部渡る（前の run に残った分も拾う）", async () => {
    await seedFailing(["前に書いた分"]);
    await deliver({ messageId: "777777777777777771" });

    setStub(fireOk);
    const outcome = await deliver({ messageId: "777777777777777772" });

    const text = firedText();
    expect(text).toContain("前に書いた分");
    expect(text).toContain("つづきをお願い");
    for (const row of await inboxRows()) {
      expect(row.taken_by_run_key).toBe(outcome.runKey);
    }
  });
});

describe("起こし直せない形", () => {
  it("プロジェクトが無効化されていたら run を立てない", async () => {
    await seedFinished();
    await env.DB.prepare("UPDATE projects SET disabled_at = ? WHERE id = ?")
      .bind(Date.now(), projectId)
      .run();

    const outcome = await deliver();

    expect(outcome).toEqual({ decision: "restart", runKey: null });
    expect(await runRows()).toHaveLength(1);
    expect(stub.callsTo("api.anthropic.com")).toEqual([]);
    expect((await inboxRows())[0]?.taken_at).toBeNull();
  });

  it("別のプロジェクトの run は巻き込まない", async () => {
    const other = await seedProject({
      name: "another",
      discordChannelId: "333333333333333333",
    });
    await seedRun({
      runKey: "OFFDESK-2222222222222222",
      projectId: other,
      channelId: "333333333333333333",
      threadId: "555555555555555551",
      status: "running",
    });
    await seedFinished();

    await deliver();

    const untouched = (await runRows()).find(
      (row) => row.run_key === "OFFDESK-2222222222222222",
    );
    expect(untouched?.status).toBe("running");
  });
});
