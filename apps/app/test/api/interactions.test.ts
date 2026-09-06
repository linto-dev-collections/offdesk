import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../../src/worker/index.ts";
import {
  CHANNEL_ALPHA,
  CHANNEL_BETA,
  runRows,
  seedProject,
  seedTwoProjects,
} from "../db/support.ts";
import {
  commandInteraction,
  createSigningKeys,
  OWNER_ID,
  type SigningKeys,
  STRANGER_ID,
  signedRequest,
} from "../discord/support.ts";
import { discordOk, jsonResponse, stubOutbound } from "../support/outbound.ts";

let keys: SigningKeys;

beforeAll(async () => {
  keys = await createSigningKeys();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const send = async (
  body: unknown,
  overrides: Partial<typeof env> = {},
): Promise<{ response: Response; settle: () => Promise<void> }> => {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    await signedRequest(keys, body),
    { ...env, DISCORD_PUBLIC_KEY: keys.publicKeyHex, ...overrides },
    ctx,
  );
  return { response, settle: () => waitOnExecutionContext(ctx) };
};

const fireOk = () =>
  jsonResponse({
    claude_code_session_id: "session_01abc",
    claude_code_session_url: "https://claude.ai/code/session_01abc",
  });

const EPHEMERAL = 64;

describe("PING", () => {
  it("type 1 を返す", async () => {
    const { response, settle } = await send({ type: 1 });

    expect(await response.json()).toEqual({ type: 1 });
    await settle();
  });
});

describe("持ち主判定（plans/security.md 脅威 14）", () => {
  it("持ち主なら通る", async () => {
    stubOutbound([
      ["discord.com", discordOk({})],
      ["api.anthropic.com", fireOk],
    ]);
    await seedTwoProjects();

    const { response, settle } = await send(
      commandInteraction({ userId: OWNER_ID, task: "READMEを直す" }),
    );

    expect(await response.json()).toEqual({
      type: 5,
      data: { flags: EPHEMERAL },
    });
    await settle();
  });

  /** **その人にだけ見える形**（ephemeral）で断る。 */
  it("別の人には ephemeral で断る", async () => {
    await seedTwoProjects();

    const { response, settle } = await send(
      commandInteraction({ userId: STRANGER_ID, task: "READMEを直す" }),
    );

    const body = (await response.json()) as {
      type: number;
      data: { content: string; flags: number };
    };
    expect(body.type).toBe(4);
    expect(body.data.flags).toBe(EPHEMERAL);
    expect(body.data.content).toContain("持ち主専用");
    await settle();

    expect(await runRows()).toHaveLength(0);
  });

  /*
    要件 `I-2`。**未設定なら誰も通らない。**
    このテストが落ちるとき、offdesk は「設定を忘れたら誰でも Claude を動かせる」になる。
  */
  it.each(["", "   "])("OWNER が %o なら持ち主でも通らない", async (owner) => {
    await seedTwoProjects();

    const { response, settle } = await send(
      commandInteraction({ userId: OWNER_ID, task: "READMEを直す" }),
      { OWNER_DISCORD_USER_ID: owner },
    );

    expect(((await response.json()) as { type: number }).type).toBe(4);
    await settle();

    expect(await runRows()).toHaveLength(0);
  });

  it("ユーザー id が取れなければ通らない", async () => {
    await seedTwoProjects();

    const { response, settle } = await send(
      commandInteraction({ userId: null, task: "READMEを直す" }),
    );

    expect(((await response.json()) as { type: number }).type).toBe(4);
    await settle();
  });
});

describe("行き先の決定（要件 F-A2・F-A3）", () => {
  it("チャンネルの紐付けで決まる", async () => {
    const stub = stubOutbound([
      ["discord.com", discordOk({})],
      ["api.anthropic.com", fireOk],
    ]);
    await seedTwoProjects();

    const { settle } = await send(
      commandInteraction({ task: "READMEを直す", channelId: CHANNEL_BETA }),
    );
    await settle();

    const [run] = await runRows();
    expect(run?.channel_id).toBe(CHANNEL_BETA);
    expect(
      stub.callsTo(`/channels/${CHANNEL_BETA}/messages`).length,
    ).toBeGreaterThan(0);
  });

  it("スレッドの中なら parent_id で決まる", async () => {
    stubOutbound([
      ["discord.com", discordOk({})],
      ["api.anthropic.com", fireOk],
    ]);
    await seedTwoProjects();

    const { settle } = await send(
      commandInteraction({
        task: "READMEを直す",
        channelId: "999999999999999999",
        parentId: CHANNEL_ALPHA,
      }),
    );
    await settle();

    const [run] = await runRows();
    // **スレッドではなく親**（テーブル定義書 §4-3）。
    expect(run?.channel_id).toBe(CHANNEL_ALPHA);
  });

  /*
    要件 `F-A2`・計画 P2 §3-2。**黙って選ばない。**
    落ちたら、雑談チャンネルの `/offdesk` が本番リポジトリに飛ぶ。
  */
  it("紐付いていないチャンネルでは選ばず、使える名前を返す", async () => {
    await seedTwoProjects();

    const { response, settle } = await send(
      commandInteraction({
        task: "READMEを直す",
        channelId: "999999999999999999",
      }),
    );

    const body = (await response.json()) as { data: { content: string } };
    expect(body.data.content).toContain("dummy");
    expect(body.data.content).toContain("offdesk-test");
    await settle();

    expect(await runRows()).toHaveLength(0);
  });

  it("プロジェクトが 1 つだけでも黙って選ばない", async () => {
    await seedProject({
      name: "offdesk-test",
      discordChannelId: CHANNEL_ALPHA,
    });

    const { response, settle } = await send(
      commandInteraction({
        task: "READMEを直す",
        channelId: "999999999999999999",
      }),
    );

    expect(((await response.json()) as { type: number }).type).toBe(4);
    await settle();

    expect(await runRows()).toHaveLength(0);
  });

  it("知らない project 名は断る（チャンネルに落とさない）", async () => {
    await seedTwoProjects();

    const { response, settle } = await send(
      commandInteraction({
        task: "READMEを直す",
        project: "typo",
        channelId: CHANNEL_ALPHA,
      }),
    );

    const body = (await response.json()) as { data: { content: string } };
    expect(body.data.content).toContain("typo");
    await settle();

    expect(await runRows()).toHaveLength(0);
  });

  it("project の明示はチャンネルより強い", async () => {
    stubOutbound([
      ["discord.com", discordOk({})],
      ["api.anthropic.com", fireOk],
    ]);
    await seedTwoProjects();

    const { settle } = await send(
      commandInteraction({
        task: "READMEを直す",
        project: "dummy",
        channelId: CHANNEL_ALPHA,
      }),
    );
    await settle();

    const [run] = await runRows();
    expect(run?.channel_id).toBe(CHANNEL_BETA);
  });
});

describe("入力の検査", () => {
  it("task が無ければ断る", async () => {
    await seedTwoProjects();

    const { response, settle } = await send(commandInteraction({}));

    const body = (await response.json()) as { data: { content: string } };
    expect(body.data.content).toContain("task");
    await settle();
  });

  it("知らないコマンドは断る", async () => {
    const { response, settle } = await send(
      commandInteraction({ task: "x", name: "kanata" }),
    );

    const body = (await response.json()) as { data: { content: string } };
    expect(body.data.content).toContain("知らないコマンド");
    await settle();
  });

  /*
    **どちらか片方を黙って優先しない。** 打ち間違いをそのまま通すと、
    「別の対象で走った run」になって初めて分かる。
  */
  it("issue と pr の両方は断る", async () => {
    await seedTwoProjects();

    const { response, settle } = await send(
      commandInteraction({ task: "READMEを直す", issue: 123, pr: 45 }),
    );

    const body = (await response.json()) as { data: { content: string } };
    expect(body.data.content).toContain("どちらか 1 つ");
    await settle();
  });

  it("プロジェクトが 0 件なら投入を案内する", async () => {
    const { response, settle } = await send(
      commandInteraction({ task: "READMEを直す" }),
    );

    const body = (await response.json()) as { data: { content: string } };
    expect(body.data.content).toContain("projects:sync");
    await settle();
  });
});

describe("押した人への返し", () => {
  /*
    **`<#id>` で参照する。** URL を組むと guild id が要り、`/channels/@me/<id>` は
    DM の形なのでサーバー内のスレッドには当たらない（実測で気付いた）。
  */
  it("スレッドを `<#id>` で指す", async () => {
    const stub = stubOutbound([
      ["discord.com", discordOk({ threadId: "444444444444444444" })],
      ["api.anthropic.com", fireOk],
    ]);
    await seedTwoProjects();

    const { settle } = await send(commandInteraction({ task: "READMEを直す" }));
    await settle();

    const [edit] = stub.callsTo("/messages/@original");
    expect(edit?.body).toContain("<#444444444444444444>");
    expect(edit?.body).not.toContain("/channels/@me/");
  });

  it("スレッドを作れなかったらそう伝える", async () => {
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
    await seedTwoProjects();

    const { settle } = await send(commandInteraction({ task: "READMEを直す" }));
    await settle();

    const [edit] = stub.callsTo("/messages/@original");
    expect(edit?.body).toContain("スレッドを作れなかった");
  });

  it("起動に失敗したら理由を返す（URL もトークンも載せない）", async () => {
    const stub = stubOutbound([
      ["discord.com", discordOk({})],
      ["api.anthropic.com", () => jsonResponse({}, 401)],
    ]);
    await seedTwoProjects();

    const { settle } = await send(commandInteraction({ task: "READMEを直す" }));
    await settle();

    const [edit] = stub.callsTo("/messages/@original");
    expect(edit?.body).toContain("起動できませんでした");
    expect(edit?.body).not.toContain("sk-ant");
    expect(edit?.body).not.toContain("trig_");
  });
});

describe("3 秒の壁（要件 F-A5・I-10）", () => {
  /*
    **一次応答が起動を待たないこと**を、時間ではなく順序で見る（計画 README §2-3:
    「時間で待つテストを書かない」）。応答が返った時点で外への呼び出しが
    1 つも起きていなければ、待っていない。
  */
  it("応答が返る時点で Discord も Anthropic も呼んでいない", async () => {
    const stub = stubOutbound([
      ["discord.com", discordOk({})],
      ["api.anthropic.com", fireOk],
    ]);
    await seedTwoProjects();

    const { response, settle } = await send(
      commandInteraction({ task: "READMEを直す" }),
    );

    expect(await response.json()).toEqual({
      type: 5,
      data: { flags: EPHEMERAL },
    });
    expect(stub.calls).toHaveLength(0);

    await settle();
    expect(stub.calls.length).toBeGreaterThan(0);
  });
});
