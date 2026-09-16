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

/** 同じ id を 2 回送るテスト用（既定の採番を使うと毎回違う値になる）。 */
const REPLAY_ID = "700000000000009999";

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
    expect(body.data.content).toContain("/projects");
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

/*
  **同じ interaction を 2 回処理しない**（2026-09-16）。

  Ed25519 の検査は「Discord が作った本物か」しか言わないので、
  **同じ本物の再送**はそのまま通る —— `/offdesk` の 1 回は routine の実行回数を
  1 つ消費し、Anthropic の `fire` には idempotency key が無い
  （`Each successful request creates a new session.`）ので、こちらで止める。
*/
describe("interaction の冪等化", () => {
  const interactionRows = async (): Promise<
    readonly { id: string; kind: string; run_key: string | null }[]
  > => {
    const { results } = await env.DB.prepare(
      "SELECT id, kind, run_key FROM discord_interactions ORDER BY id",
    ).all<{ id: string; kind: string; run_key: string | null }>();
    return results;
  };

  it("同じ id の 2 通目は起動しない", async () => {
    const stub = stubOutbound([
      ["discord.com", discordOk({})],
      ["api.anthropic.com", fireOk],
    ]);
    await seedTwoProjects();

    const body = commandInteraction({ task: "READMEを直す", id: REPLAY_ID });

    const first = await send(body);
    await first.settle();
    const fired = stub.callsTo("api.anthropic.com").length;

    const second = await send(body);
    const replyBody = (await second.response.json()) as {
      data?: { content?: string };
    };
    await second.settle();

    expect(replyBody.data?.content).toContain("既に受け付けています");
    expect(stub.callsTo("api.anthropic.com")).toHaveLength(fired);
    expect(await runRows()).toHaveLength(1);
  });

  /** どの `/offdesk` がどの run になったかを残す（監査用）。 */
  it("確保した行に run を結び付ける", async () => {
    stubOutbound([
      ["discord.com", discordOk({})],
      ["api.anthropic.com", fireOk],
    ]);
    await seedTwoProjects();

    const { settle } = await send(
      commandInteraction({ task: "READMEを直す", id: REPLAY_ID }),
    );
    await settle();

    const [row] = await interactionRows();
    expect(row?.id).toBe(REPLAY_ID);
    expect(row?.kind).toBe("command");
    expect(row?.run_key).toBe((await runRows())[0]?.run_key);
  });

  /*
    **起動できなかった interaction も確保したままにする。** 解放すると、
    落ちた要求の再送が 2 本目を立てられる —— 依頼者はもう一度 `/offdesk` を
    打てばよい（新しい id になる）ので、取りこぼしよりも二重起動を避ける。
  */
  it("起動に失敗しても id は解放しない", async () => {
    stubOutbound([
      ["discord.com", discordOk({})],
      ["api.anthropic.com", () => jsonResponse({ error: "nope" }, 500)],
    ]);
    await seedTwoProjects();

    const body = commandInteraction({ task: "READMEを直す", id: REPLAY_ID });
    const first = await send(body);
    await first.settle();

    const second = await send(body);
    const replyBody = (await second.response.json()) as {
      data?: { content?: string };
    };
    await second.settle();

    expect(replyBody.data?.content).toContain("既に受け付けています");
    expect(await runRows()).toHaveLength(1);
  });

  /** **PING は台帳に触らない**（Discord は疎通確認で何度でも送ってくる）。 */
  it("PING は確保しない", async () => {
    const { response, settle } = await send({ type: 1, id: REPLAY_ID });
    await settle();

    expect(await response.json()).toEqual({ type: 1 });
    expect(await interactionRows()).toEqual([]);
  });

  /** id が無い interaction は Discord のものではない。 */
  it("id が無ければ起動しない", async () => {
    const stub = stubOutbound([
      ["discord.com", discordOk({})],
      ["api.anthropic.com", fireOk],
    ]);
    await seedTwoProjects();

    const { id: _id, ...withoutId } = commandInteraction({
      task: "READMEを直す",
    });
    const { settle } = await send(withoutId);
    await settle();

    expect(stub.callsTo("api.anthropic.com")).toHaveLength(0);
    expect(await runRows()).toHaveLength(0);
  });
});

/*
  **署名が正しいことは「いま来た」を意味しない**（`DISCORD_SIGNATURE_WINDOW_MS`）。
  一度撮られた正規の要求は、何か月後でも同じ Ed25519 の検査を通る。
*/
describe("署名の新しさ", () => {
  const at = (offsetMs: number): string =>
    String(Math.floor((Date.now() + offsetMs) / 1000));

  it.each([
    ["1 時間前", -60 * 60_000],
    ["1 時間後", 60 * 60_000],
    ["ちょうど 6 分前", -6 * 60_000],
  ])("%s の署名は 401", async (_label, offsetMs) => {
    const stub = stubOutbound([
      ["discord.com", discordOk({})],
      ["api.anthropic.com", fireOk],
    ]);
    await seedTwoProjects();

    const ctx = createExecutionContext();
    const response = await worker.fetch(
      await signedRequest(keys, commandInteraction({ task: "READMEを直す" }), {
        timestamp: at(offsetMs),
      }),
      { ...env, DISCORD_PUBLIC_KEY: keys.publicKeyHex },
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(401);
    expect(stub.calls).toHaveLength(0);
    expect(await runRows()).toHaveLength(0);
  });

  it.each([
    ["1 分前", -60_000],
    ["いま", 0],
  ])("%s の署名は通る", async (_label, offsetMs) => {
    stubOutbound([
      ["discord.com", discordOk({})],
      ["api.anthropic.com", fireOk],
    ]);
    await seedTwoProjects();

    const ctx = createExecutionContext();
    const response = await worker.fetch(
      await signedRequest(keys, commandInteraction({ task: "READMEを直す" }), {
        timestamp: at(offsetMs),
      }),
      { ...env, DISCORD_PUBLIC_KEY: keys.publicKeyHex },
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
  });

  /** **数字でない timestamp を 1970 年として読まない。** */
  it.each(["", "   ", "not-a-number", "17884.27539"])(
    "timestamp が %o なら 401",
    async (timestamp) => {
      const ctx = createExecutionContext();
      const response = await worker.fetch(
        await signedRequest(keys, { type: 1 }, { timestamp }),
        { ...env, DISCORD_PUBLIC_KEY: keys.publicKeyHex },
        ctx,
      );
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(401);
    },
  );
});
