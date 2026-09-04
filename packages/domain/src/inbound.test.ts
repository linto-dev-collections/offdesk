import { describe, expect, it } from "vitest";
import {
  decideInbound,
  foldInboundLines,
  INBOUND_ACTIVE_WINDOW_MS,
  INBOUND_HELD_WINDOW_MS,
  type RunSnapshot,
  resolveInboundWindows,
} from "./inbound.ts";

/*
  4 通りの判定（要件 `F-C2`・計画 P4 §3-4）。

  ここで固めたいのは「窓が 2 つ別」であること —— 握りは短く（60 秒）、
  作業中は長い（6 時間）。同じ窓で見ると**「20 分黙って実装している最中の 1 行」で
  2 本目の run が立つ**（要件 `F-C6` が「取り返せない」と書いている形）。
*/

const NOW = 1_788_600_000_000;
const ASK = { askId: "ask_1111111111111111" };

const run = (overrides: Partial<RunSnapshot> = {}): RunSnapshot => ({
  terminal: false,
  heldAt: null,
  activityAt: null,
  createdAt: NOW,
  ...overrides,
});

const decide = (input: {
  readonly run?: RunSnapshot | null;
  readonly pendingAsk?: { readonly askId: string } | null;
  readonly now?: number;
}) =>
  decideInbound({
    run: input.run === undefined ? run() : input.run,
    pendingAsk: input.pendingAsk ?? null,
    now: input.now ?? NOW,
  });

describe("offdesk の会話ではない", () => {
  /** 親チャンネルの発言はそもそも run が引けない（要件 `F-C3`）。 */
  it("run が無ければ何も起きない", () => {
    expect(decide({ run: null })).toEqual({ kind: "ignore" });
  });

  it("問いが待っていても run が無ければ何も起きない", () => {
    expect(decide({ run: null, pendingAsk: ASK })).toEqual({ kind: "ignore" });
  });
});

describe("待っている質問がある → 回答", () => {
  it("握りが生きていれば answer", () => {
    expect(
      decide({
        run: run({ heldAt: NOW - 1_000 }),
        pendingAsk: ASK,
      }),
    ).toEqual({ kind: "answer", askId: ASK.askId });
  });

  it("窓のちょうど内側は answer", () => {
    expect(
      decide({
        run: run({ heldAt: NOW - INBOUND_HELD_WINDOW_MS + 1 }),
        pendingAsk: ASK,
      }).kind,
    ).toBe("answer");
  });

  it("問いが無ければ answer にならない", () => {
    expect(decide({ run: run({ heldAt: NOW }) }).kind).toBe("queue");
  });

  /*
    **握りが死んでいるのに回答へ倒さない**（要件 `F-C5`）。倒すと、落ちた run の
    未回答の問いが**以後そのスレッドの発言を永久に飲み込む穴**になる。
  */
  it("握りが古ければ answer にしない", () => {
    expect(
      decide({
        run: run({ heldAt: NOW - INBOUND_HELD_WINDOW_MS }),
        pendingAsk: ASK,
      }).kind,
    ).not.toBe("answer");
  });

  it("握った印が一度も付いていなければ answer にしない", () => {
    expect(
      decide({ run: run({ heldAt: null }), pendingAsk: ASK }).kind,
    ).not.toBe("answer");
  });
});

describe("作業中 → 溜まる", () => {
  it("起動直後は queue（held_at も activity_at も NULL）", () => {
    /*
      **`created_at` を見ていないと、ここが `restart` になる。**
      起動 5 秒後の 1 行で 2 本目の run が立つ形（要件 `I-13` が禁じている）。
    */
    expect(decide({ run: run({ createdAt: NOW - 5_000 }) }).kind).toBe("queue");
  });

  /** 計画 P4 §5 が名指しで挙げている形。**`restart` にしない。** */
  it("held_at が古く activity_at が新しいときは queue", () => {
    expect(
      decide({
        run: run({
          createdAt: NOW - 3 * 60 * 60_000,
          heldAt: NOW - 30 * 60_000,
          activityAt: NOW - 20 * 60_000,
        }),
        pendingAsk: ASK,
      }).kind,
    ).toBe("queue");
  });

  it("20 分黙って実装している最中でも queue", () => {
    expect(
      decide({
        run: run({
          createdAt: NOW - 60 * 60_000,
          activityAt: NOW - 20 * 60_000,
        }),
      }).kind,
    ).toBe("queue");
  });

  it("握りだけが新しくても（報告が無くても）queue", () => {
    expect(
      decide({
        run: run({ createdAt: NOW - 5 * 60 * 60_000, heldAt: NOW - 1_000 }),
      }).kind,
    ).toBe("queue");
  });

  it("長い窓のちょうど内側は queue", () => {
    expect(
      decide({
        run: run({ createdAt: NOW - INBOUND_ACTIVE_WINDOW_MS + 1 }),
      }).kind,
    ).toBe("queue");
  });
});

describe("終わっている / 落ちている → 起こし直す", () => {
  /*
    **終端の検査を窓より先に置くのが要点。** `done` になった直後の run は
    `activity_at` が新しいので、逆順にすると「終わった run に溜め続けて
    誰にも届かない」になる。
  */
  it("終端の run は activity_at が新しくても restart", () => {
    expect(decide({ run: run({ terminal: true, activityAt: NOW }) }).kind).toBe(
      "restart",
    );
  });

  it("終端の run は未回答の問いがあっても restart", () => {
    expect(
      decide({
        run: run({ terminal: true, heldAt: NOW }),
        pendingAsk: ASK,
      }).kind,
    ).toBe("restart");
  });

  it("長い窓を過ぎたら restart", () => {
    expect(
      decide({
        run: run({ createdAt: NOW - INBOUND_ACTIVE_WINDOW_MS }),
      }).kind,
    ).toBe("restart");
  });

  it("未回答の問いがあっても、長い窓を過ぎていれば restart", () => {
    expect(
      decide({
        run: run({
          createdAt: NOW - 2 * INBOUND_ACTIVE_WINDOW_MS,
          heldAt: NOW - INBOUND_ACTIVE_WINDOW_MS,
        }),
        pendingAsk: ASK,
      }).kind,
    ).toBe("restart");
  });
});

describe("窓の長さは設定で縮められる（要件 N-9）", () => {
  it("既定は 60 秒と 6 時間", () => {
    expect(resolveInboundWindows()).toEqual({
      heldMs: 60_000,
      activeMs: 6 * 60 * 60_000,
    });
  });

  it("環境変数で上書きできる", () => {
    expect(
      resolveInboundWindows({
        INBOUND_HELD_WINDOW_MS: "40",
        INBOUND_ACTIVE_WINDOW_MS: "80",
      }),
    ).toEqual({ heldMs: 40, activeMs: 80 });
  });

  /** `Number("")` は 0、`Number("abc")` は NaN。**0 が既定に化けないこと。** */
  it.each(["", "  ", "abc", "0", "-1"])("不正な値（%s）は既定に倒す", (raw) => {
    expect(resolveInboundWindows({ INBOUND_HELD_WINDOW_MS: raw })).toEqual({
      heldMs: INBOUND_HELD_WINDOW_MS,
      activeMs: INBOUND_ACTIVE_WINDOW_MS,
    });
  });

  it("縮めた窓で判定が変わる", () => {
    const shared = {
      run: run({ createdAt: NOW - 100, heldAt: NOW - 100 }),
      pendingAsk: ASK,
      now: NOW,
    };

    expect(
      decideInbound({ ...shared, windows: { heldMs: 200, activeMs: 200 } })
        .kind,
    ).toBe("answer");
    expect(
      decideInbound({ ...shared, windows: { heldMs: 50, activeMs: 200 } }).kind,
    ).toBe("queue");
    expect(
      decideInbound({ ...shared, windows: { heldMs: 50, activeMs: 50 } }).kind,
    ).toBe("restart");
  });
});

describe("foldInboundLines", () => {
  it("空行 1 つで繋ぐ", () => {
    expect(foldInboundLines(["1 行目", "2 行目", "3 行目"])).toBe(
      "1 行目\n\n2 行目\n\n3 行目",
    );
  });

  it("1 行ならそのまま", () => {
    expect(foldInboundLines(["これだけ"])).toBe("これだけ");
  });

  it("空白だけの行は落とす", () => {
    expect(foldInboundLines(["  ", "本文", "\n"])).toBe("本文");
  });

  it("全部空なら空文字（呼ぶ側が run を立てない判断に使う）", () => {
    expect(foldInboundLines(["", "   "])).toBe("");
    expect(foldInboundLines([])).toBe("");
  });
});
