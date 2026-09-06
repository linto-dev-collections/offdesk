import { env } from "cloudflare:workers";
import { NO_TARGET, type RunTarget } from "@offdesk/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { launchRunWithEnv } from "../../src/worker/session/launch.ts";
import {
  CHANNEL_ALPHA,
  FIRE_URL,
  runRows,
  seedProject,
} from "../db/support.ts";
import { discordOk, jsonResponse, stubOutbound } from "../support/outbound.ts";

/*
  起動の流れ（計画 P2 §3-9）。**Discord と Anthropic は差し替える**（§5）。
*/

const REQUESTER = "111111111111111111";

const launch = async (
  overrides: { fireUrl?: string; target?: RunTarget } = {},
) =>
  await launchRunWithEnv(env, {
    projectId: await seedProject({
      name: "offdesk-test",
      discordChannelId: CHANNEL_ALPHA,
      fireUrl: overrides.fireUrl ?? FIRE_URL,
    }),
    projectName: "offdesk-test",
    channelId: CHANNEL_ALPHA,
    repoUrl: "https://github.com/linto-dev-collections/offdesk-test",
    fireUrl: overrides.fireUrl ?? FIRE_URL,
    prompt: "READMEにtypoを1つ入れて直すPRを作って",
    requesterDiscordUserId: REQUESTER,
    target: overrides.target ?? NO_TARGET,
  });

const fireOk = () =>
  jsonResponse({
    claude_code_session_id: "session_01abc",
    claude_code_session_url: "https://claude.ai/code/session_01abc",
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("作業対象（`/offdesk` の issue / pr）", () => {
  const REPO = "https://github.com/linto-dev-collections/offdesk-test";

  it("Issue はスレッド名・payload・起動メッセージに出る", async () => {
    const stub = stubOutbound([
      ["discord.com", discordOk({ threadId: "444444444444444444" })],
      ["api.anthropic.com", fireOk],
    ]);

    await launch({ target: { kind: "issue", number: 123 } });

    expect(stub.callsTo("/threads")[0]?.body).toContain("OFFDESK #123");
    expect(stub.callsTo("api.anthropic.com")[0]?.body).toContain(
      "claude/issue-123",
    );
    /* **`repo_url` から組む** ので、GitHub の API も token も要らない。 */
    expect(stub.callsTo("/messages")[0]?.body).toContain(`${REPO}/issues/123`);
  });

  /*
    **PR の run はブランチを作らない。** ここが緩むと、レビューのつもりの run が
    空のブランチと 2 本目の PR を残す。
  */
  it("PR ではブランチを作らせない", async () => {
    const stub = stubOutbound([
      ["discord.com", discordOk({ threadId: "444444444444444444" })],
      ["api.anthropic.com", fireOk],
    ]);

    await launch({ target: { kind: "pull", number: 45 } });

    expect(stub.callsTo("/threads")[0]?.body).toContain("OFFDESK PR#45");

    const fired = stub.callsTo("api.anthropic.com")[0]?.body ?? "";
    expect(fired).toContain("Pull Request #45");
    expect(fired).not.toContain("claude/");

    expect(stub.callsTo("/messages")[0]?.body).toContain(`${REPO}/pull/45`);
  });

  it("指定が無ければスレッド名は今まで通り", async () => {
    const stub = stubOutbound([
      ["discord.com", discordOk({ threadId: "444444444444444444" })],
      ["api.anthropic.com", fireOk],
    ]);

    await launch();

    expect(stub.callsTo("/threads")[0]?.body).toContain("OFFDESK READMEに");
  });
});

describe("うまくいったとき", () => {
  it("run が running になり、cc の id と URL が対で入る", async () => {
    stubOutbound([
      ["discord.com", discordOk({ threadId: "444444444444444444" })],
      ["api.anthropic.com", fireOk],
    ]);

    const outcome = await launch();

    expect(outcome.failureReason).toBeNull();
    expect(outcome.threadId).toBe("444444444444444444");

    const [run] = await runRows();
    expect(run?.status).toBe("running");
    expect(run?.thread_id).toBe("444444444444444444");
    expect(run?.cc_session_id).toBe("session_01abc");
    expect(run?.cc_session_url).toBe("https://claude.ai/code/session_01abc");
    expect(run?.channel_id).toBe(CHANNEL_ALPHA);
  });

  it("run_key が DDL の形を満たす", async () => {
    stubOutbound([
      ["discord.com", discordOk({})],
      ["api.anthropic.com", fireOk],
    ]);

    const outcome = await launch();

    expect(outcome.runKey).toMatch(/^OFFDESK-[0-9a-f]{16}$/);
  });

  /*
    **fire の 1 行目が run_key。** MCP（P3a）と hook（P5）がこれを読む前提なので、
    形が変わったらここが落ちる。
  */
  it("fire の text の 1 行目が run_key", async () => {
    const stub = stubOutbound([
      ["discord.com", discordOk({})],
      ["api.anthropic.com", fireOk],
    ]);

    const outcome = await launch();

    const [fire] = stub.callsTo("api.anthropic.com");
    const body = JSON.parse(fire?.body ?? "{}") as { text?: string };
    expect(body.text?.split("\n")[0]).toBe(outcome.runKey);
  });

  it("fire に beta ヘッダと Bearer が載る", async () => {
    const stub = stubOutbound([
      ["discord.com", discordOk({})],
      ["api.anthropic.com", fireOk],
    ]);

    await launch();

    const [fire] = stub.callsTo("api.anthropic.com");
    expect(fire?.headers["anthropic-beta"]).toBe(
      "experimental-cc-routine-2026-04-01",
    );
    expect(fire?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(fire?.headers.authorization).toBe(
      "Bearer sk-ant-oat01-test-token-aB3x",
    );
  });

  /** 要件 `F-A4`。**対象リポジトリを 1 行出す。** */
  it("起動メッセージに対象リポジトリが出る", async () => {
    const stub = stubOutbound([
      ["discord.com", discordOk({})],
      ["api.anthropic.com", fireOk],
    ]);

    await launch();

    const [anchor] = stub.callsTo("/messages");
    expect(anchor?.body).toContain(
      "https://github.com/linto-dev-collections/offdesk-test",
    );
  });
});

describe("スレッドを作れなかったとき", () => {
  /*
    要件 `F-A7`・`I-4`。**`thread_id` は NULL のまま。**
    チャンネル id を入れると、そのチャンネルの雑談が丸ごと Claude への入力になる。
  */
  it("thread_id が NULL のままになる", async () => {
    stubOutbound([
      [
        "discord.com",
        (call) =>
          call.url.includes("/threads")
            ? jsonResponse({ message: "Missing Permissions" }, 403)
            : jsonResponse({ id: "333333333333333333" }),
      ],
      ["api.anthropic.com", fireOk],
    ]);

    const outcome = await launch();

    expect(outcome.threadId).toBeNull();

    const [run] = await runRows();
    expect(run?.thread_id).toBeNull();
    // 起動そのものは成功しているので `running`。
    expect(run?.status).toBe("running");
  });

  it("通知はチャンネルへ落ちる", async () => {
    const stub = stubOutbound([
      [
        "discord.com",
        (call) =>
          call.url.includes("/threads")
            ? jsonResponse({}, 403)
            : jsonResponse({ id: "333333333333333333" }),
      ],
      ["api.anthropic.com", fireOk],
    ]);

    await launch();

    const posts = stub.callsTo(`/channels/${CHANNEL_ALPHA}/messages`);
    expect(posts.length).toBeGreaterThanOrEqual(2);
    expect(posts.at(-1)?.body).toContain("スレッドを作れませんでした");
  });
});

describe("起動に失敗したとき", () => {
  /*
    要件 `F-A6`・`runs_finished_ck`。**`failed` と `finished_at` は同時に入る。**
    別々の UPDATE にすると 1 本目で CHECK に落ちる。
  */
  it("status=failed と finished_at が同時に入る", async () => {
    stubOutbound([
      ["discord.com", discordOk({ threadId: "444444444444444444" })],
      ["api.anthropic.com", () => jsonResponse({ error: "nope" }, 500)],
    ]);

    const outcome = await launch();

    expect(outcome.failureReason).toContain("500");

    const [run] = await runRows();
    expect(run?.status).toBe("failed");
    expect(run?.finished_at).not.toBeNull();
    expect(run?.failure_reason).toContain("500");
  });

  /** 脅威 12。**理由に URL とトークンを載せない。** */
  it("失敗の理由に URL もトークンも載らない", async () => {
    stubOutbound([
      ["discord.com", discordOk({})],
      ["api.anthropic.com", () => jsonResponse({}, 401)],
    ]);

    const outcome = await launch();

    expect(outcome.failureReason).not.toContain("anthropic.com");
    expect(outcome.failureReason).not.toContain("sk-ant");
    expect(outcome.failureReason).not.toContain("trig_");
  });

  /*
    plans/security.md 脅威 3 の 3 層目。**送信前に落ちる。**
    D1 の CHECK と CLI の Zod をすり抜けた値でも、ここで止まる。
  */
  it("許可されていない fire_url なら Anthropic へ出ない", async () => {
    // DDL が別ホストを弾くので、行は正しい値で作って引数だけ差し替える。
    const stub = stubOutbound([["discord.com", discordOk({})]]);

    const outcome = await launchRunWithEnv(env, {
      projectId: await seedProject({
        name: "offdesk-test",
        discordChannelId: CHANNEL_ALPHA,
      }),
      projectName: "offdesk-test",
      channelId: CHANNEL_ALPHA,
      repoUrl: "https://github.com/x/y",
      fireUrl: "https://evil.example.com/v1/fire",
      prompt: "READMEを直す",
      requesterDiscordUserId: REQUESTER,
      target: NO_TARGET,
    });

    expect(outcome.failureReason).toContain("fire_url");
    expect(stub.calls.every((call) => call.url.includes("discord.com"))).toBe(
      true,
    );

    const [run] = await runRows();
    expect(run?.status).toBe("failed");
  });

  it("fire の応答形が変わっても run は running（URL だけ NULL）", async () => {
    stubOutbound([
      ["discord.com", discordOk({})],
      ["api.anthropic.com", () => jsonResponse({ unexpected: "shape" })],
    ]);

    const outcome = await launch();

    expect(outcome.failureReason).toBeNull();
    expect(outcome.ccSessionUrl).toBeNull();

    const [run] = await runRows();
    expect(run?.status).toBe("running");
    expect(run?.cc_session_id).toBeNull();
    expect(run?.cc_session_url).toBeNull();
  });
});

describe("同じスレッドに 2 本目", () => {
  /*
    要件 `I-13`。**起こし直しの経路は P4。** P2 の時点で 2 本目を作ろうとしたら
    D1 が止める（`runs_live_thread_uidx`）。落ちる方が、2 本立つより安い。
  */
  it("生きている run があるスレッドには紐付けられない", async () => {
    stubOutbound([
      ["discord.com", discordOk({ threadId: "444444444444444444" })],
      ["api.anthropic.com", fireOk],
    ]);

    await launch();

    await expect(launch()).rejects.toThrow();

    // 1 本目は残っている（**行を消さない**）。
    const rows = await runRows();
    expect(
      rows.filter((r) => r.thread_id === "444444444444444444"),
    ).toHaveLength(1);
  });
});
