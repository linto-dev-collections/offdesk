import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { insertAsk } from "@offdesk/db";
import { answerCustomId, MAX_ASK_OPTIONS } from "@offdesk/domain";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import worker from "../../src/worker/index.ts";
import {
  askRows,
  db,
  runStatus,
  seedRun,
  seedTwoProjects,
} from "../db/support.ts";
import {
  componentInteraction,
  createSigningKeys,
  OWNER_ID,
  type SigningKeys,
  STRANGER_ID,
  signedRequest,
} from "../discord/support.ts";

/*
  回答ボタン（要件 `F-B4`・plans/security.md 脅威 14）。

  **押した人が持ち主かを見る。** 署名が正しい正規の interaction でも、
  送り主が持ち主でないことがある。違えば台帳を**書き換えない。**

  答えが Claude へ渡るのは握っている `ask_human` の戻り値なので、ここで見るのは
  「台帳に入るか」と「Discord の見え方が直るか」の 2 つ。
*/

const ASK_ID = "ask_0123456789abcdef";
const OPTIONS = ["はい", "やめる"] as const;
const EPHEMERAL = 64;
const REPLY_MESSAGE = 4;
const REPLY_UPDATE_MESSAGE = 7;

let keys: SigningKeys;
let runKey: string;

beforeAll(async () => {
  keys = await createSigningKeys();
});

beforeEach(async () => {
  const { alpha } = await seedTwoProjects();
  runKey = await seedRun({ projectId: alpha, status: "waiting" });
  await insertAsk(
    db(),
    {
      askId: ASK_ID,
      runKey,
      question: "この方針で進めてよいですか",
      options: OPTIONS,
    },
    Date.now(),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const press = async (input: {
  readonly customId: string;
  readonly userId?: string | null;
}): Promise<Record<string, unknown>> => {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    await signedRequest(keys, componentInteraction(input)),
    { ...env, DISCORD_PUBLIC_KEY: keys.publicKeyHex },
    ctx,
  );
  const body = (await response.json()) as Record<string, unknown>;
  await waitOnExecutionContext(ctx);
  return body;
};

describe("持ち主が押したとき", () => {
  it("answer が入る", async () => {
    await press({ customId: answerCustomId(ASK_ID, 0) });

    const [row] = await askRows();
    expect(row?.answer).toBe("はい");
    expect(row?.answered_at).not.toBeNull();
    expect(row?.answered_by_discord_user_id).toBe(OWNER_ID);
  });

  it("index どおりの選択肢が入る", async () => {
    await press({ customId: answerCustomId(ASK_ID, 1) });

    expect((await askRows())[0]?.answer).toBe("やめる");
  });

  /*
    **ボタン由来なら `answer_message_id` は NULL のまま**（テーブル定義書 §4-4）。
    あれは「回答が素の文から来たとき」の列で、入れると P4 が
    「素の文の 👀 を ✅ に変える」相手を取り違える。
  */
  it("answer_message_id は NULL のまま", async () => {
    await press({ customId: answerCustomId(ASK_ID, 0) });

    expect((await askRows())[0]?.answer_message_id).toBeNull();
  });

  /*
    **`delivered_at` はここで立てない**（要件 `I-3`）。立てるのは握りが
    Claude へ書き出せた時点で、ここで立てると答えが宙に浮いたまま「渡した」ことになる。
  */
  it("delivered_at は立てない", async () => {
    await press({ customId: answerCustomId(ASK_ID, 0) });

    expect((await askRows())[0]?.delivered_at).toBeNull();
  });

  it("run が running に戻る", async () => {
    await press({ customId: answerCustomId(ASK_ID, 0) });

    expect(await runStatus(runKey)).toBe("running");
  });

  it("元のメッセージを書き換えてボタンを消す", async () => {
    const body = await press({ customId: answerCustomId(ASK_ID, 0) });

    expect(body.type).toBe(REPLY_UPDATE_MESSAGE);
    const data = body.data as {
      content: string;
      components: readonly unknown[];
    };
    // **空配列を明示する。** 省略すると Discord は「変更なし」と解釈してボタンが残る。
    expect(data.components).toEqual([]);
    expect(data.content).toContain("この方針で進めてよいですか");
    expect(data.content).toContain("→ はい");
  });
});

describe("持ち主以外が押したとき（脅威 14）", () => {
  it("答えにならない", async () => {
    await press({ customId: answerCustomId(ASK_ID, 0), userId: STRANGER_ID });

    const [row] = await askRows();
    expect(row?.answer).toBeNull();
    expect(row?.answered_at).toBeNull();
    expect(row?.answered_by_discord_user_id).toBeNull();
  });

  it("その人にだけ見える形で断る", async () => {
    const body = await press({
      customId: answerCustomId(ASK_ID, 0),
      userId: STRANGER_ID,
    });

    expect(body.type).toBe(REPLY_MESSAGE);
    expect((body.data as { flags: number }).flags).toBe(EPHEMERAL);
  });

  it("run の状態も動かさない", async () => {
    await press({ customId: answerCustomId(ASK_ID, 0), userId: STRANGER_ID });

    expect(await runStatus(runKey)).toBe("waiting");
  });

  it("押した人が分からないときも答えにならない", async () => {
    await press({ customId: answerCustomId(ASK_ID, 0), userId: null });

    expect((await askRows())[0]?.answer).toBeNull();
  });

  /*
    **`OWNER_DISCORD_USER_ID` が未設定なら誰も通らない**（要件 `I-2`）。
    空文字どうしが一致して全開になる形を作らない。
  */
  it("OWNER_DISCORD_USER_ID が未設定なら持ち主でも通らない", async () => {
    const ctx = createExecutionContext();
    await worker.fetch(
      await signedRequest(
        keys,
        componentInteraction({ customId: answerCustomId(ASK_ID, 0) }),
      ),
      {
        ...env,
        DISCORD_PUBLIC_KEY: keys.publicKeyHex,
        OWNER_DISCORD_USER_ID: "",
      },
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect((await askRows())[0]?.answer).toBeNull();
  });
});

describe("押せない形", () => {
  it("2 回目は「回答済み」と言って上書きしない", async () => {
    await press({ customId: answerCustomId(ASK_ID, 0) });
    const body = await press({ customId: answerCustomId(ASK_ID, 1) });

    expect(body.type).toBe(REPLY_MESSAGE);
    expect((body.data as { content: string }).content).toContain("回答済み");
    // **最初の答えが残る。** 上書きすると、Claude が受け取った答えと台帳が食い違う。
    expect((await askRows())[0]?.answer).toBe("はい");
  });

  it("知らない ask_id は何も書かない", async () => {
    const body = await press({
      customId: answerCustomId("ask_ffffffffffffffff", 0),
    });

    expect((body.data as { content: string }).content).toContain(
      "見つかりませんでした",
    );
    expect((await askRows())[0]?.answer).toBeNull();
  });

  it("範囲の外の index は何も書かない", async () => {
    const body = await press({ customId: answerCustomId(ASK_ID, 5) });

    expect((body.data as { content: string }).content).toContain(
      "選択肢は見つかりませんでした",
    );
    expect((await askRows())[0]?.answer).toBeNull();
  });

  it.each([
    ["別の接頭辞", `pick:${ASK_ID}:0`],
    ["区切りが足りない", `ans:${ASK_ID}`],
    ["index が数字でない", `ans:${ASK_ID}:x`],
    ["index が空", `ans:${ASK_ID}:`],
    ["上限以上の index", `ans:${ASK_ID}:${MAX_ASK_OPTIONS}`],
  ])("%s の custom_id は何も書かない", async (_label, customId) => {
    const body = await press({ customId });

    expect((body.data as { content: string }).content).toContain(
      "対応していません",
    );
    expect((await askRows())[0]?.answer).toBeNull();
  });
});
