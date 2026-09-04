import { describe, expect, it } from "vitest";
import {
  GATEWAY_OP,
  type GatewayFrameAction,
  type GatewayInput,
  parseGatewayFrame,
} from "./gateway.ts";

/*
  フレームの読み方（計画 P4 §3-3）。

  **ここを DO に置くとテストできない。** `WebSocketPair` は DO の I/O 文脈を
  越えられないので（2026-09-04 に実測: `Cannot perform I/O on behalf of a
  different Durable Object`）、**ソケットを張って DO へフレームを流す**テストは
  書けない。だから読み方を純粋関数に出し、境界の形をここで全部踏む。

  **投げないことが最優先。** 壊れたフレーム 1 つで常駐接続が落ちると、
  素の文が届かなくなる（症状は「たまに反応しない」で、いちばん切り分けにくい）。
*/

const AT = 1_788_600_000_000;

const parse = (frame: unknown): readonly GatewayFrameAction[] =>
  parseGatewayFrame(JSON.stringify(frame), AT);

const inputsOf = (
  actions: readonly GatewayFrameAction[],
): readonly GatewayInput[] => {
  const inputs: GatewayInput[] = [];
  for (const action of actions) {
    if (action.kind === "input") inputs.push(action.input);
  }
  return inputs;
};

const messageOf = (actions: readonly GatewayFrameAction[]) => {
  for (const action of actions) {
    if (action.kind === "message") return action.message;
  }
  return null;
};

const kindsOf = (actions: readonly GatewayFrameAction[]): readonly string[] =>
  actions.map((action) => action.kind);

describe("hello（op 10）", () => {
  it("heartbeat_interval を渡す", () => {
    const actions = parse({
      op: GATEWAY_OP.hello,
      d: { heartbeat_interval: 41_250 },
    });

    expect(inputsOf(actions)).toEqual([
      { kind: "hello", at: AT, heartbeatIntervalMs: 41_250 },
    ]);
  });

  /*
    **間隔が分からないまま進まない。** 推測した周期で撃つと 4008（rate limited）か
    無 ACK で切られる。期限（`GATEWAY_HELLO_TIMEOUT_MS`）が来て張り直す。
  */
  it.each([
    ["d が無い", { op: GATEWAY_OP.hello }],
    ["d が空", { op: GATEWAY_OP.hello, d: {} }],
    ["文字列", { op: GATEWAY_OP.hello, d: { heartbeat_interval: "41250" } }],
    ["0", { op: GATEWAY_OP.hello, d: { heartbeat_interval: 0 } }],
    ["負", { op: GATEWAY_OP.hello, d: { heartbeat_interval: -1 } }],
    ["d が配列", { op: GATEWAY_OP.hello, d: [41_250] }],
  ])("%s なら何もしない", (_label, frame) => {
    expect(parse(frame)).toEqual([]);
  });
});

describe("ハートビート", () => {
  it("op 11（ACK）は生きている証拠になる", () => {
    expect(inputsOf(parse({ op: GATEWAY_OP.heartbeatAck }))).toEqual([
      { kind: "ack", at: AT },
    ]);
  });

  /*
    **op 1 は「いますぐ返せ」の要求。** `step` を通さずに返すのが正しい ——
    周期の話ではないので、通すと次の周期がずれる。
  */
  it("op 1 は beat（即座に返す）", () => {
    expect(kindsOf(parse({ op: GATEWAY_OP.heartbeat, d: null }))).toEqual([
      "beat",
    ]);
  });
});

describe("READY / RESUMED", () => {
  it("READY で session_id と resume_gateway_url を渡す", () => {
    const actions = parse({
      op: GATEWAY_OP.dispatch,
      s: 3,
      t: "READY",
      d: {
        session_id: "session-abc",
        resume_gateway_url: "wss://gateway-us-east1-b.discord.gg",
      },
    });

    expect(inputsOf(actions)).toEqual([
      {
        kind: "ready",
        at: AT,
        sessionId: "session-abc",
        resumeUrl: "wss://gateway-us-east1-b.discord.gg",
        seq: 3,
      },
    ]);
  });

  /** 揃っていないと resume ができない形になる。期限が来て張り直す。 */
  it.each([
    ["session_id が無い", { resume_gateway_url: "wss://x" }],
    ["resume_gateway_url が無い", { session_id: "s" }],
    ["session_id が空文字", { session_id: "", resume_gateway_url: "wss://x" }],
    ["両方無い", {}],
  ])("READY の %s なら何もしない", (_label, d) => {
    expect(parse({ op: GATEWAY_OP.dispatch, s: 1, t: "READY", d })).toEqual([]);
  });

  it("RESUMED で seq を渡す", () => {
    expect(
      inputsOf(parse({ op: GATEWAY_OP.dispatch, s: 9, t: "RESUMED", d: {} })),
    ).toEqual([{ kind: "resumed", at: AT, seq: 9 }]);
  });

  it("s が無ければ 0 として扱う（seq を進めない）", () => {
    expect(
      inputsOf(parse({ op: GATEWAY_OP.dispatch, t: "RESUMED", d: {} })),
    ).toEqual([{ kind: "resumed", at: AT, seq: 0 }]);
  });
});

describe("MESSAGE_CREATE", () => {
  const messageCreate = (d: Record<string, unknown>) => ({
    op: GATEWAY_OP.dispatch,
    s: 12,
    t: "MESSAGE_CREATE",
    d: {
      id: "777777777777777777",
      channel_id: "444444444444444444",
      content: "README も直して",
      author: { id: "111111111111111111", bot: false },
      ...d,
    },
  });

  /*
    **2 つ返す。** `seq` を進める `dispatch` と、本文を渡す `message` ——
    片方だけにすると `seq` が止まり、次の resume が 4007（invalid seq）で切られる。
  */
  it("dispatch と message の 2 つを返す", () => {
    const actions = parse(messageCreate({}));

    expect(kindsOf(actions)).toEqual(["input", "message"]);
    expect(inputsOf(actions)).toEqual([{ kind: "dispatch", at: AT, seq: 12 }]);
  });

  it("判定に要るものだけを抜く", () => {
    expect(messageOf(parse(messageCreate({})))).toEqual({
      messageId: "777777777777777777",
      channelId: "444444444444444444",
      authorId: "111111111111111111",
      authorIsBot: false,
      content: "README も直して",
    });
  });

  /** **bot の印は `bot: true` だけ**（脅威 14。`"true"` や 1 を通さない）。 */
  it.each([
    ["true", true, true],
    ["false", false, false],
    ["無い", undefined, false],
    ["文字列の true", "true", false],
    ["1", 1, false],
  ])("author.bot が %s なら %s", (_label, bot, expected) => {
    const message = messageOf(
      parse(messageCreate({ author: { id: "111111111111111111", bot } })),
    );

    expect(message?.authorIsBot).toBe(expected);
  });

  it("content が無ければ空文字（添付だけの発言）", () => {
    expect(
      messageOf(parse(messageCreate({ content: undefined })))?.content,
    ).toBe("");
  });

  /*
    **形が足りないフレームは `seq` だけ進める。** 本文が誰のものか分からないので
    渡さないが、`seq` を止めると resume が壊れる。
  */
  it.each([
    ["id が無い", { id: undefined }],
    ["channel_id が無い", { channel_id: undefined }],
    ["author が無い", { author: undefined }],
    ["author.id が無い", { author: { bot: false } }],
    ["id が空文字", { id: "" }],
    ["author が配列", { author: [] }],
  ])("%s なら dispatch だけ", (_label, d) => {
    const actions = parse(messageCreate(d));

    expect(kindsOf(actions)).toEqual(["input"]);
    expect(inputsOf(actions)).toEqual([{ kind: "dispatch", at: AT, seq: 12 }]);
  });

  it("d ごと無いときも dispatch だけ", () => {
    const actions = parse({
      op: GATEWAY_OP.dispatch,
      s: 12,
      t: "MESSAGE_CREATE",
    });

    expect(kindsOf(actions)).toEqual(["input"]);
  });
});

describe("その他の dispatch", () => {
  /** 知らないイベントも `seq` は進める（resume のため）。 */
  it("知らない t は dispatch だけ", () => {
    const actions = parse({
      op: GATEWAY_OP.dispatch,
      s: 5,
      t: "TYPING_START",
      d: {},
    });

    expect(kindsOf(actions)).toEqual(["input"]);
    expect(inputsOf(actions)).toEqual([{ kind: "dispatch", at: AT, seq: 5 }]);
  });
});

describe("op 7 / op 9", () => {
  it("op 7 は reconnect", () => {
    expect(inputsOf(parse({ op: GATEWAY_OP.reconnect, d: null }))).toEqual([
      { kind: "reconnect", at: AT },
    ]);
  });

  /** **`true` 以外は全部「resume できない」。** 誤って resume すると同じ理由で切られる。 */
  it.each([
    ["true", true, true],
    ["false", false, false],
    ["null", null, false],
    ["文字列の true", "true", false],
    ["1", 1, false],
  ])("op 9 の d が %s なら resumable=%s", (_label, d, resumable) => {
    expect(inputsOf(parse({ op: GATEWAY_OP.invalidSession, d }))).toEqual([
      { kind: "invalidSession", at: AT, resumable },
    ]);
  });
});

describe("読めないフレームで落ちない", () => {
  /*
    **投げないことが最優先。** 壊れたフレーム 1 つで常駐接続が落ちると、
    素の文が届かなくなる —— 症状は「たまに反応しない」で、いちばん切り分けにくい。
  */
  it.each([
    ["空文字", ""],
    ["JSON ではない", "not json"],
    ["配列", "[1,2,3]"],
    ["数", "42"],
    ["null", "null"],
    ["op が無い", "{}"],
    ["op が文字列", '{"op":"10"}'],
    ["知らない op", '{"op":99}'],
  ])("%s は何もしない", (_label, raw) => {
    expect(parseGatewayFrame(raw, AT)).toEqual([]);
  });
});
