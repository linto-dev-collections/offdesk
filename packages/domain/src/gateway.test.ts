import { describe, expect, it } from "vitest";
import {
  backoffDelayMs,
  GATEWAY_BACKOFF_BASE_MS,
  GATEWAY_BACKOFF_JITTER_MS,
  GATEWAY_BACKOFF_MAX_MS,
  GATEWAY_CLOSE_RESTART,
  GATEWAY_CONNECT_TIMEOUT_MS,
  GATEWAY_HELLO_TIMEOUT_MS,
  GATEWAY_INTENTS,
  GATEWAY_READY_TIMEOUT_MS,
  GATEWAY_RESTART_WAIT_MS,
  type GatewayEffect,
  type GatewayInput,
  type GatewayState,
  isFatalCloseCode,
  isGatewayHealthy,
  step,
  zombieWindowMs,
} from "./gateway.ts";

/*
  Gateway の状態遷移（計画 P4 §5）。**ソケットを張るテストは書かない。**
  ゾンビ接続・op 9 の `d:false`・close 4014 は本番でしか起きないので、
  入力を手で作れることそのものがこの純粋関数を切った理由（要件 `F-I5`）。
*/

const T0 = 1_788_600_000_000;
const HEARTBEAT_MS = 41_250;
const SESSION_ID = "session-abc";
const RESUME_URL = "wss://gateway-us-east1-b.discord.gg";

const drive = (
  state: GatewayState,
  inputs: readonly GatewayInput[],
): { state: GatewayState; effects: readonly GatewayEffect[] } => {
  let current = state;
  let effects: readonly GatewayEffect[] = [];
  for (const input of inputs) {
    const result = step(current, input);
    current = result.next;
    effects = result.effects;
  }
  return { state: current, effects };
};

const kindsOf = (effects: readonly GatewayEffect[]): readonly string[] =>
  effects.map((effect) => effect.kind);

/*
  **`as` を書かずに絞り込む**（計画 README §2-3）。`find` の戻り値は合併のままなので、
  for + 早期 return で絞る小さな口をそれぞれ用意する。
*/

const alarmOf = (effects: readonly GatewayEffect[]): number | null => {
  for (const effect of effects) {
    if (effect.kind === "alarm") return effect.atMs;
  }
  throw new Error("alarm が返っていません");
};

const connectUrlOf = (effects: readonly GatewayEffect[]): string => {
  for (const effect of effects) {
    if (effect.kind === "connect") return effect.url;
  }
  throw new Error("connect が返っていません");
};

const heartbeatSeqOf = (effects: readonly GatewayEffect[]): number | null => {
  for (const effect of effects) {
    if (effect.kind === "heartbeat") return effect.seq;
  }
  throw new Error("heartbeat が返っていません");
};

const disconnectCodeOf = (effects: readonly GatewayEffect[]): number => {
  for (const effect of effects) {
    if (effect.kind === "disconnect") return effect.code;
  }
  throw new Error("disconnect が返っていません");
};

const resumeOf = (
  effects: readonly GatewayEffect[],
): { sessionId: string; seq: number | null } => {
  for (const effect of effects) {
    if (effect.kind === "resume") {
      return { sessionId: effect.sessionId, seq: effect.seq };
    }
  }
  throw new Error("resume が返っていません");
};

/** `idle` から握手を通して `live` まで運ぶ（多くのテストの出発点）。 */
const toLive = (at = T0): GatewayState =>
  drive({ kind: "idle" }, [
    { kind: "tick", at },
    { kind: "open", at },
    { kind: "hello", at, heartbeatIntervalMs: HEARTBEAT_MS },
    {
      kind: "ready",
      at,
      sessionId: SESSION_ID,
      resumeUrl: RESUME_URL,
      seq: 1,
    },
  ]).state;

describe("intent（Developer Portal のトグルと対）", () => {
  /*
    **`MESSAGE_CONTENT`（1 << 15）が抜けると close 4014 で切られる** ——
    本文が空で届くのではなく、接続そのものが張れない。
    **`GUILDS`（1 << 0）はスレッドの同期に要る**（外すと静かに 1 通も届かない）。
  */
  it.each([
    ["GUILDS", 1 << 0],
    ["GUILD_MESSAGES", 1 << 9],
    ["MESSAGE_CONTENT", 1 << 15],
  ])("%s が立っている", (_label, bit) => {
    expect(GATEWAY_INTENTS & bit).toBe(bit);
  });

  it.each([
    ["GUILD_MEMBERS", 1 << 1],
    ["GUILD_PRESENCES", 1 << 8],
    ["DIRECT_MESSAGES", 1 << 12],
  ])("要らない intent（%s）は取らない", (_label, bit) => {
    expect(GATEWAY_INTENTS & bit).toBe(0);
  });
});

describe("握手が通る", () => {
  it("idle に tick を入れると繋ぎに行く", () => {
    const { state, effects } = drive({ kind: "idle" }, [
      { kind: "tick", at: T0 },
    ]);

    expect(state.kind).toBe("connecting");
    expect(kindsOf(effects)).toEqual(["connect", "alarm"]);
    // **`wss://` を渡さない**（`fetch` が即座に落ちる）。
    expect(connectUrlOf(effects)).toContain("https://");
    expect(alarmOf(effects)).toBe(T0 + GATEWAY_CONNECT_TIMEOUT_MS);
  });

  /*
    **`open` の役目は期限の張り替え。** 「そもそも開かない」（10 秒）と
    「開いたのに黙っている」（30 秒）は別の失敗で、上限も別。
  */
  it("open で hello を待つ側の期限に張り替わる", () => {
    const { effects } = drive({ kind: "idle" }, [
      { kind: "tick", at: T0 },
      { kind: "open", at: T0 + 100 },
    ]);

    expect(alarmOf(effects)).toBe(T0 + 100 + GATEWAY_HELLO_TIMEOUT_MS);
  });

  it("hello で identify を送り、ハートビートの時計が動き出す", () => {
    const { state, effects } = drive({ kind: "idle" }, [
      { kind: "tick", at: T0 },
      { kind: "open", at: T0 },
      { kind: "hello", at: T0, heartbeatIntervalMs: HEARTBEAT_MS },
    ]);

    expect(state.kind).toBe("connecting");
    expect(kindsOf(effects)).toEqual(["identify", "alarm"]);
    // READY の期限（30 秒）より 1 回目のハートビート（41.25 秒）が遅いので、期限が勝つ。
    expect(alarmOf(effects)).toBe(T0 + GATEWAY_READY_TIMEOUT_MS);
  });

  it("ready で live になる", () => {
    const state = toLive();

    expect(state.kind).toBe("live");
    if (state.kind !== "live") return;
    expect(state.session).toEqual({
      sessionId: SESSION_ID,
      resumeUrl: RESUME_URL,
      seq: 1,
    });
    expect(state.lastEventAt).toBe(T0);
  });

  /*
    **hello の前の READY は受け取らない。** ハートビートの間隔が分からないまま
    `live` にすると周期を推測することになる。期限が来て張り直すので詰まらない。
  */
  it("hello を受ける前の ready は無視する", () => {
    const { state } = drive({ kind: "idle" }, [
      { kind: "tick", at: T0 },
      {
        kind: "ready",
        at: T0,
        sessionId: SESSION_ID,
        resumeUrl: RESUME_URL,
        seq: 1,
      },
    ]);

    expect(state.kind).toBe("connecting");
  });
});

describe("ハートビートとゾンビ検出", () => {
  it("間隔が来たら送る", () => {
    const { state, effects } = drive(toLive(), [
      { kind: "tick", at: T0 + HEARTBEAT_MS },
    ]);

    expect(kindsOf(effects)).toEqual(["heartbeat", "alarm"]);
    expect(heartbeatSeqOf(effects)).toBe(1);
    expect(state.kind).toBe("live");
  });

  it("間隔の前は送らない", () => {
    const { effects } = drive(toLive(), [
      { kind: "tick", at: T0 + HEARTBEAT_MS - 1 },
    ]);

    expect(kindsOf(effects)).toEqual(["alarm"]);
  });

  /*
    **遅れた分を取り戻そうとしない。** DO が evict されて alarm が遅れたとき、
    `nextAt + interval` で積み上げるとハートビートを連続で撃って 4008 で切られる。
  */
  it("大きく遅れても次の 1 回だけを予定する", () => {
    // ACK は届いているので接続は生きている（ゾンビではなく alarm が遅れた形）。
    const late = T0 + HEARTBEAT_MS * 10;
    const { state } = drive(toLive(), [
      { kind: "ack", at: late },
      { kind: "tick", at: late },
    ]);

    expect(state.kind).toBe("live");
    if (state.kind !== "live") return;
    expect(state.heartbeat.nextAt).toBe(late + HEARTBEAT_MS);
  });

  /*
    **ACK も「生きている」の証拠。** 静かなサーバーでは `MESSAGE_CREATE` が
    何時間も来ないので、dispatch だけを見ていると正常な接続がゾンビ判定される。
  */
  it("ack で無音の時計が戻る", () => {
    const acked = drive(toLive(), [{ kind: "ack", at: T0 + 1_000 }]).state;

    expect(acked.kind === "live" && acked.lastEventAt).toBe(T0 + 1_000);
  });

  it("dispatch で seq と無音の時計が進む", () => {
    const { state } = drive(toLive(), [
      { kind: "dispatch", at: T0 + 500, seq: 7 },
    ]);

    expect(state.kind === "live" && state.session.seq).toBe(7);
    expect(state.kind === "live" && state.lastEventAt).toBe(T0 + 500);
  });

  it("無音が続くとゾンビと判定して切り、張り直す", () => {
    const zombieAt = T0 + zombieWindowMs(HEARTBEAT_MS);
    const { state, effects } = drive(toLive(), [
      { kind: "tick", at: zombieAt },
    ]);

    expect(state.kind).toBe("backoff");
    expect(kindsOf(effects)).toEqual(["disconnect", "alarm"]);
    expect(disconnectCodeOf(effects)).toBe(GATEWAY_CLOSE_RESTART);
  });

  it("ゾンビの手前ではハートビートを送るだけ", () => {
    const almost = T0 + zombieWindowMs(HEARTBEAT_MS) - 1;
    const { state, effects } = drive(toLive(), [{ kind: "tick", at: almost }]);

    expect(state.kind).toBe("live");
    expect(kindsOf(effects)).toContain("heartbeat");
  });

  /** ゾンビでもセッションは捨てない（張り直しは resume で済む）。 */
  it("ゾンビからの張り直しは resume を持っている", () => {
    const zombieAt = T0 + zombieWindowMs(HEARTBEAT_MS);
    const backoff = drive(toLive(), [{ kind: "tick", at: zombieAt }]).state;

    expect(backoff.kind === "backoff" && backoff.resume?.sessionId).toBe(
      SESSION_ID,
    );
  });
});

describe("直らない失敗では張り直さない（要件 F-I4・脅威 15）", () => {
  /*
    **Discord のドキュメントが Reconnect = false と言っている 6 つ全部**を
    `fatal` にしている。計画の表は 4004 と 4014 だけを挙げているが、
    残りも「何回繋いでも同じところで切られる」ので、張り続けると
    identify のレート制限（1 日 1000 回）を静かに使い切る。
  */
  it.each([4004, 4010, 4011, 4012, 4013, 4014])(
    "close %i で fatal になる",
    (code) => {
      const { state, effects } = drive(toLive(), [
        { kind: "close", at: T0 + 1_000, code },
      ]);

      expect(state).toEqual({ kind: "fatal", reason: `close_${code}` });
      // **alarm を消す。** 残すと「張り直さない」が守れない。
      expect(alarmOf(effects)).toBeNull();
      expect(kindsOf(effects)).toEqual(["alarm"]);
    },
  );

  it.each([4000, 4001, 4002, 4003, 4005, 4007, 4008, 4009, 1006])(
    "close %i は一時的な失敗として backoff",
    (code) => {
      const { state } = drive(toLive(), [
        { kind: "close", at: T0 + 1_000, code },
      ]);

      expect(state.kind).toBe("backoff");
    },
  );

  it("fatal は tick でも close でも動かない", () => {
    const fatal = drive(toLive(), [
      { kind: "close", at: T0, code: 4014 },
    ]).state;

    for (const input of [
      { kind: "tick", at: T0 + 10 * 60_000 },
      { kind: "close", at: T0 + 10 * 60_000, code: 4000 },
      { kind: "open", at: T0 + 10 * 60_000 },
    ] satisfies GatewayInput[]) {
      const { next, effects } = step(fatal, input);
      expect(next).toEqual(fatal);
      expect(kindsOf(effects)).toEqual(["alarm"]);
      expect(alarmOf(effects)).toBeNull();
    }
  });

  it("reset だけが fatal から出られる", () => {
    const fatal = drive(toLive(), [
      { kind: "close", at: T0, code: 4004 },
    ]).state;

    const { next, effects } = step(fatal, { kind: "reset", at: T0 + 60_000 });

    expect(next.kind).toBe("connecting");
    expect(kindsOf(effects)).toEqual(["disconnect", "connect", "alarm"]);
  });

  /** **reset は resume を捨てる。** 人が叩いたのは今の状態が信用できないから。 */
  it("reset は素の宛先へ繋ぎ直す", () => {
    const { effects } = drive(toLive(), [{ kind: "reset", at: T0 + 60_000 }]);

    expect(connectUrlOf(effects)).toContain("gateway.discord.gg");
    expect(connectUrlOf(effects)).not.toContain("us-east1-b");
  });

  it("isFatalCloseCode が判定を 1 か所で持っている", () => {
    expect(isFatalCloseCode(4014)).toBe(true);
    expect(isFatalCloseCode(4000)).toBe(false);
  });
});

describe("バックオフ（指数 ＋ 上限）", () => {
  it("1 回目は基準値", () => {
    expect(backoffDelayMs(1, T0)).toBeGreaterThanOrEqual(
      GATEWAY_BACKOFF_BASE_MS,
    );
    expect(backoffDelayMs(1, T0)).toBeLessThan(
      GATEWAY_BACKOFF_BASE_MS + GATEWAY_BACKOFF_JITTER_MS,
    );
  });

  it("回数が増えると倍になる", () => {
    // ジッタの幅を跨がない比較にするため、同じ `at` で比べる。
    const at = T0 - (T0 % GATEWAY_BACKOFF_JITTER_MS);
    expect(backoffDelayMs(2, at)).toBe(GATEWAY_BACKOFF_BASE_MS * 2);
    expect(backoffDelayMs(3, at)).toBe(GATEWAY_BACKOFF_BASE_MS * 4);
  });

  /** **上限が無いと指数が伸び切って実質「諦め」になる**（脅威 15）。 */
  it("上限を超えない", () => {
    for (const attempt of [10, 50, 1_000]) {
      expect(backoffDelayMs(attempt, T0)).toBeLessThan(
        GATEWAY_BACKOFF_MAX_MS + GATEWAY_BACKOFF_JITTER_MS,
      );
    }
  });

  it("ジッタが乗る（同じ回数でも時刻で変わる）", () => {
    expect(backoffDelayMs(1, T0 + 1)).not.toBe(backoffDelayMs(1, T0 + 2));
  });

  it("0 以下の回数でも基準値より短くならない", () => {
    expect(backoffDelayMs(0, T0)).toBeGreaterThanOrEqual(
      GATEWAY_BACKOFF_BASE_MS,
    );
  });

  it("待ちが明けるまで繋ぎに行かない", () => {
    const backoff = drive(toLive(), [
      { kind: "close", at: T0, code: 4000 },
    ]).state;
    expect(backoff.kind).toBe("backoff");
    if (backoff.kind !== "backoff") return;

    expect(
      step(backoff, { kind: "tick", at: backoff.until - 1 }).next.kind,
    ).toBe("backoff");
    expect(step(backoff, { kind: "tick", at: backoff.until }).next.kind).toBe(
      "connecting",
    );
  });

  it("失敗が続くと回数が積み上がる", () => {
    let state = toLive();
    const delays: number[] = [];

    for (let round = 0; round < 3; round += 1) {
      const at = T0 + round * 60 * 60_000;
      state = step(state, { kind: "close", at, code: 4000 }).next;
      if (state.kind !== "backoff") throw new Error("backoff になっていません");
      delays.push(state.until - at);
      // 待ちが明けて繋ぎに行き、握手が終わらないまま期限が来る。
      state = step(state, { kind: "tick", at: state.until }).next;
      if (state.kind !== "connecting") {
        throw new Error("connecting になっていません");
      }
      state = step(state, { kind: "tick", at: state.deadline }).next;
      if (state.kind !== "backoff") throw new Error("backoff に戻っていません");
      state = step(state, { kind: "tick", at: state.until }).next;
    }

    expect(delays[1]).toBeGreaterThan(delays[0] ?? 0);
    expect(delays[2]).toBeGreaterThan(delays[1] ?? 0);
  });
});

describe("resume", () => {
  it("op 7 は resume を持ったまま短く待って張り直す", () => {
    const { state, effects } = drive(toLive(), [
      { kind: "reconnect", at: T0 + 1_000 },
    ]);

    expect(state.kind).toBe("backoff");
    if (state.kind !== "backoff") return;
    expect(state.until).toBe(T0 + 1_000 + GATEWAY_RESTART_WAIT_MS);
    expect(state.resume?.sessionId).toBe(SESSION_ID);
    expect(kindsOf(effects)).toEqual(["disconnect", "alarm"]);
  });

  it("resume を持っていれば resume_gateway_url へ繋ぐ", () => {
    const backoff = drive(toLive(), [{ kind: "reconnect", at: T0 }]).state;
    if (backoff.kind !== "backoff") throw new Error("backoff ではありません");

    const { effects } = step(backoff, { kind: "tick", at: backoff.until });

    expect(connectUrlOf(effects)).toContain("us-east1-b");
    // **クエリを付け直す**（`resume_gateway_url` には付いてこない）。
    expect(connectUrlOf(effects)).toContain("v=10");
  });

  it("hello のあと identify ではなく resume を送る", () => {
    const backoff = drive(toLive(), [{ kind: "reconnect", at: T0 }]).state;
    if (backoff.kind !== "backoff") throw new Error("backoff ではありません");
    const at = backoff.until;

    const { effects } = drive(backoff, [
      { kind: "tick", at },
      { kind: "open", at },
      { kind: "hello", at, heartbeatIntervalMs: HEARTBEAT_MS },
    ]);

    expect(resumeOf(effects)).toEqual({ sessionId: SESSION_ID, seq: 1 });
  });

  it("resumed で live に戻る（session_id を持ち越す）", () => {
    const backoff = drive(toLive(), [{ kind: "reconnect", at: T0 }]).state;
    if (backoff.kind !== "backoff") throw new Error("backoff ではありません");
    const at = backoff.until;

    const { state } = drive(backoff, [
      { kind: "tick", at },
      { kind: "open", at },
      { kind: "hello", at, heartbeatIntervalMs: HEARTBEAT_MS },
      { kind: "resumed", at, seq: 9 },
    ]);

    expect(state.kind).toBe("live");
    expect(state.kind === "live" && state.session.sessionId).toBe(SESSION_ID);
    expect(state.kind === "live" && state.session.seq).toBe(9);
  });

  /*
    **取りこぼし分は RESUMED より先に流れてくる**（仕様）。ここで `seq` を
    進めないと、次の resume が古い `seq` を送って 4007 で切られる。
  */
  it("resume の再生中に来た dispatch で seq が進む", () => {
    const backoff = drive(toLive(), [{ kind: "reconnect", at: T0 }]).state;
    if (backoff.kind !== "backoff") throw new Error("backoff ではありません");
    const at = backoff.until;

    const { state } = drive(backoff, [
      { kind: "tick", at },
      { kind: "open", at },
      { kind: "hello", at, heartbeatIntervalMs: HEARTBEAT_MS },
      { kind: "dispatch", at: at + 10, seq: 5 },
      { kind: "resumed", at: at + 20, seq: 6 },
    ]);

    expect(state.kind === "live" && state.session.seq).toBe(6);
  });

  it("再生が長引いても期限が延びる", () => {
    const backoff = drive(toLive(), [{ kind: "reconnect", at: T0 }]).state;
    if (backoff.kind !== "backoff") throw new Error("backoff ではありません");
    const at = backoff.until;

    const { state } = drive(backoff, [
      { kind: "tick", at },
      { kind: "open", at },
      { kind: "hello", at, heartbeatIntervalMs: HEARTBEAT_MS },
      { kind: "dispatch", at: at + 25_000, seq: 5 },
    ]);

    expect(state.kind === "connecting" && state.deadline).toBe(
      at + 25_000 + GATEWAY_READY_TIMEOUT_MS,
    );
  });
});

describe("invalid session（op 9）", () => {
  it("resumable なら resume を持ったまま張り直す", () => {
    const { state } = drive(toLive(), [
      { kind: "invalidSession", at: T0, resumable: true },
    ]);

    expect(state.kind === "backoff" && state.resume?.sessionId).toBe(
      SESSION_ID,
    );
  });

  /** **捨てないと同じ理由でまた切られる。** 次は素の identify から。 */
  it("resumable でなければセッションを捨てて再 identify", () => {
    const backoff = drive(toLive(), [
      { kind: "invalidSession", at: T0, resumable: false },
    ]).state;

    expect(backoff.kind === "backoff" && backoff.resume).toBeNull();
    if (backoff.kind !== "backoff") return;

    const at = backoff.until;
    const { effects } = drive(backoff, [
      { kind: "tick", at },
      { kind: "open", at },
      { kind: "hello", at, heartbeatIntervalMs: HEARTBEAT_MS },
    ]);

    expect(kindsOf(effects)).toEqual(["identify", "alarm"]);
  });

  /** `seq` が無効になる close は resume を捨てる（4007 / 4009 など）。 */
  it.each([4003, 4005, 4007, 4009])("close %i は resume を捨てる", (code) => {
    const { state } = drive(toLive(), [{ kind: "close", at: T0, code }]);

    expect(state.kind === "backoff" && state.resume).toBeNull();
  });
});

describe("握手が終わらないとき", () => {
  it("ソケットが開かないまま期限が来たら張り直す", () => {
    const connecting = drive({ kind: "idle" }, [
      { kind: "tick", at: T0 },
    ]).state;
    if (connecting.kind !== "connecting") {
      throw new Error("connecting ではありません");
    }

    const { next, effects } = step(connecting, {
      kind: "tick",
      at: connecting.deadline,
    });

    expect(next.kind).toBe("backoff");
    expect(kindsOf(effects)).toEqual(["disconnect", "alarm"]);
  });

  it("hello の前でもハートビートは送らない", () => {
    const { effects } = drive({ kind: "idle" }, [
      { kind: "tick", at: T0 },
      { kind: "open", at: T0 },
      { kind: "tick", at: T0 + 1_000 },
    ]);

    expect(kindsOf(effects)).toEqual(["alarm"]);
  });

  /*
    hello は来たが READY が来ない状態でも**ハートビートは送り続ける** ——
    仕様は hello を受けた時点から送ることを求めていて、止めると
    ACK が来ずに Discord 側から切られる。
  */
  it("hello のあと READY を待つ間もハートビートを送る", () => {
    const { effects } = drive({ kind: "idle" }, [
      { kind: "tick", at: T0 },
      { kind: "open", at: T0 },
      { kind: "hello", at: T0, heartbeatIntervalMs: 5_000 },
      { kind: "tick", at: T0 + 5_000 },
    ]);

    expect(kindsOf(effects)).toEqual(["heartbeat", "alarm"]);
  });
});

describe("isGatewayHealthy", () => {
  it("live で無音が浅ければ healthy", () => {
    expect(isGatewayHealthy(toLive(), T0 + 1_000)).toBe(true);
  });

  /** **`live` だけでは足りない。** ACK が途切れかけたソケットは live のまま黙る。 */
  it("live でも無音が深ければ healthy ではない", () => {
    expect(isGatewayHealthy(toLive(), T0 + zombieWindowMs(HEARTBEAT_MS))).toBe(
      false,
    );
  });

  it.each([
    ["idle", { kind: "idle" } as GatewayState],
    ["fatal", { kind: "fatal", reason: "close_4014" } as GatewayState],
    [
      "backoff",
      { kind: "backoff", until: T0, attempt: 1, resume: null } as GatewayState,
    ],
  ])("%s は healthy ではない", (_label, state) => {
    expect(isGatewayHealthy(state, T0)).toBe(false);
  });
});
