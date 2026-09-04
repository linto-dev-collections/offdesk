import { env } from "cloudflare:workers";
import type { InboundMessage } from "@offdesk/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyInbound } from "../../src/worker/discord/inbound.ts";
import { MARK_HANDED, MARK_SEEN } from "../../src/worker/discord/marks.ts";
import {
  inboxRows,
  seedRun,
  seedTwoProjects,
  THREAD_ID,
} from "../db/support.ts";
import {
  discordOk,
  jsonResponse,
  type OutboundCall,
  type OutboundStub,
  type RouteHandler,
  stubOutbound,
} from "../support/outbound.ts";
import { OWNER_ID } from "./support.ts";

/*
  印を付けられなかったとき（要件 `F-C4`・計画 P4 §3-6）。

  **無言で握らない。** 付けられない理由はほぼ 1 つ（bot に `Add Reactions` か
  `Read Message History` が無い）だが、**ログに残さないと「実装が無いのか
  権限が無いのか」を切り分ける手掛かりが消える**（要件 `N-7`）。

  **✅ を付けられなかったときも 👀 を外さない。** 印が 1 つも無い姿にすると
  「受け取られていない」に見える —— 台帳には残っているので、それは嘘になる。
*/

const MESSAGE_ID = "777777777777777777";

let projectId: string;
let stub: OutboundStub;
let warnings: string[];

/** 印だけを失敗させる（メッセージの投稿と routine の起動は通す）。 */
const reactionsFail: RouteHandler = (call: OutboundCall) =>
  call.url.includes("/reactions/")
    ? jsonResponse({ message: "Missing Permissions", code: 50013 }, 403)
    : discordOk({ messageId: "888888888888888888" })(call);

beforeEach(async () => {
  const { alpha } = await seedTwoProjects();
  projectId = alpha;

  warnings = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.map((arg) => JSON.stringify(arg)).join(" "));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const message = (overrides: Partial<InboundMessage> = {}): InboundMessage => ({
  messageId: MESSAGE_ID,
  channelId: THREAD_ID,
  authorId: OWNER_ID,
  authorIsBot: false,
  content: "つづきをお願い",
  ...overrides,
});

const reactionCalls = (emoji: string) =>
  stub.callsTo(`/reactions/${encodeURIComponent(emoji)}/@me`);

describe("👀 を付けられなかったとき", () => {
  beforeEach(() => {
    stub = stubOutbound([["discord.com", reactionsFail]]);
  });

  /*
    **本題を止めない。** 印は「見えている状態」の話で、文を預かること自体は
    D1 に残っている —— 印が付かないからといって文を捨てると、
    権限の設定漏れが「発言が消える」という形で出る。
  */
  it("それでも inbox には積む", async () => {
    const runKey = await seedRun({ projectId });

    const outcome = await applyInbound(env, message());

    expect(outcome).toEqual({ decision: "queue", runKey });
    expect(await inboxRows()).toHaveLength(1);
  });

  it("console.warn に残る（無言で握らない）", async () => {
    await seedRun({ projectId });

    await applyInbound(env, message());

    expect(warnings.join("\n")).toContain("👀 を付けられませんでした");
  });

  /** **本文をログに出さない**（脅威 12）。出すのは id と理由だけ。 */
  it("ログに本文を出さない", async () => {
    await seedRun({ projectId });

    await applyInbound(env, message({ content: "秘密の指示" }));

    expect(warnings.join("\n")).not.toContain("秘密の指示");
    expect(warnings.join("\n")).toContain(MESSAGE_ID);
  });
});

describe("✅ を付けられなかったとき", () => {
  /** ✅ の PUT だけを失敗させ、👀 の PUT と DELETE は通す。 */
  const handedFails: RouteHandler = (call) =>
    call.url.includes(encodeURIComponent(MARK_HANDED))
      ? jsonResponse({ message: "Missing Permissions", code: 50013 }, 403)
      : discordOk({ messageId: "888888888888888888" })(call);

  beforeEach(async () => {
    stub = stubOutbound([
      ["discord.com", handedFails],
      [
        "api.anthropic.com",
        () =>
          jsonResponse({
            claude_code_session_id: "session_01mark",
            claude_code_session_url: "https://claude.ai/code/session_01mark",
          }),
      ],
    ]);

    const runKey = await seedRun({ projectId, status: "done" });
    await env.DB.prepare(
      `INSERT INTO inbox (run_key, author_discord_user_id, message_id, body)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(runKey, OWNER_ID, "666666666666666660", "前に書いた分")
      .run();
  });

  /*
    **印が 1 つも無い姿にしない**（計画 P4 §3-6）。✅ を付けられなかったのに
    👀 を外すと「受け取られていない」に見えるが、台帳では渡っている。
  */
  it("👀 を外さない", async () => {
    await applyInbound(env, message());

    expect(
      reactionCalls(MARK_HANDED).filter((c) => c.method === "PUT"),
    ).not.toEqual([]);
    expect(
      reactionCalls(MARK_SEEN).filter((c) => c.method === "DELETE"),
    ).toEqual([]);
  });

  it("console.warn に「👀 は残します」と残る", async () => {
    await applyInbound(env, message());

    expect(warnings.join("\n")).toContain("✅ を付けられませんでした");
    expect(warnings.join("\n")).toContain("👀 は残します");
  });

  /*
    **台帳の印は進める。** ✅ が付かないのは見え方の問題で、Claude へは渡っている ——
    `taken_at` を立てないと同じ文を毎回渡し続けることになる。
  */
  it("taken_at は立つ（渡ってはいる）", async () => {
    await applyInbound(env, message());

    for (const row of await inboxRows()) {
      expect(row.taken_at).not.toBeNull();
    }
  });
});

describe("👀 を外せなかったとき", () => {
  /** ✅ の PUT は通り、👀 の DELETE だけ失敗する。 */
  const removeFails: RouteHandler = (call) =>
    call.method === "DELETE"
      ? jsonResponse({ message: "Unknown Emoji", code: 10014 }, 400)
      : discordOk({ messageId: "888888888888888888" })(call);

  it("✅ は付いているので本題は止めない", async () => {
    stub = stubOutbound([
      ["discord.com", removeFails],
      [
        "api.anthropic.com",
        () =>
          jsonResponse({
            claude_code_session_id: "session_01mark",
            claude_code_session_url: "https://claude.ai/code/session_01mark",
          }),
      ],
    ]);
    const runKey = await seedRun({ projectId, status: "done" });
    await env.DB.prepare(
      `INSERT INTO inbox (run_key, author_discord_user_id, message_id, body)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(runKey, OWNER_ID, "666666666666666660", "前に書いた分")
      .run();

    const outcome = await applyInbound(env, message());

    expect(outcome.decision).toBe("restart");
    expect(warnings.join("\n")).toContain("👀 を外せませんでした");
    // 印が 2 つ並ぶだけで、意味は伝わる（✅ が付いている）。
    expect(
      reactionCalls(MARK_HANDED).filter((c) => c.method === "PUT"),
    ).not.toEqual([]);
  });
});
