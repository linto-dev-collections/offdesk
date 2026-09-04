/*
  Discord Gateway の状態遷移（計画 P4 §3-2・要件 `F-I5`）。

  **ゾンビ接続・op 9 の `d:false`・close 4014 は本番でしか起きない。** だから
  「いつ張り直すか」「いつ諦めるか」を入力を手で作れる純粋関数に切り、DO には
  「ソケットを開く / 閉じる / 送る」と「alarm を張る」しか残さない。

  **bot token はここへ来ない**（plans/security.md 脅威 15）。副作用は
  `identify` / `resume` という**名前**で返し、実際のフレームは DO が組む ——
  こうしておくと、遷移のログに token が混ざる形がそもそも作れない。
*/

import type { InboundMessage } from "./inbound.ts";

/** JSON エンコーディングの v10（`resume_gateway_url` には付いてこないので自分で付ける）。 */
const GATEWAY_VERSION = "10";
const GATEWAY_QUERY = `v=${GATEWAY_VERSION}&encoding=json`;

const GATEWAY_HOST = "gateway.discord.gg";

export const GATEWAY_URL = `wss://${GATEWAY_HOST}/`;

/** 素の宛先。**壊れた `resume_gateway_url` が来たときの倒し先**でもある。 */
const DEFAULT_CONNECT_URL = `https://${GATEWAY_HOST}/?${GATEWAY_QUERY}`;

/**
 * 受け取る／送るオペコード（Gateway ドキュメントの一覧）。
 * **DO がフレームを振り分けるのに使う。** 遷移そのものは `GatewayInput` で表す。
 */
export const GATEWAY_OP = {
  dispatch: 0,
  heartbeat: 1,
  identify: 2,
  resume: 6,
  reconnect: 7,
  invalidSession: 9,
  hello: 10,
  heartbeatAck: 11,
} as const;

/* ---- intent（要件 §9-2） ---- */

const INTENT_GUILDS = 1 << 0;
const INTENT_GUILD_MESSAGES = 1 << 9;
const INTENT_MESSAGE_CONTENT = 1 << 15;

/**
 * **Developer Portal のトグルと対で維持する。**
 *
 * `MESSAGE_CONTENT` は privileged なので、Portal で on にしていないと
 * close 4014 で切られる（本文が空で届くのではなく、**接続そのものが張れない**）。
 *
 * **`GUILDS` を入れてある。** `MESSAGE_CREATE` 自体は `GUILD_MESSAGES` で届くが、
 * スレッド関連のイベントと「見えているスレッドの同期」は `GUILDS` の側にある
 * （Discord のドキュメントが「スレッドのイベントは GUILDS」と書いている）。
 * offdesk が読みたい文は**全部スレッドの中**なので、**外して静かに 1 通も
 * 届かない**危険を取らない。privileged ではないので Portal の操作も増えない。
 *
 * **DM は取らない**（要件 `F-C3`。run のスレッドは必ずサーバーの中にある）。
 */
export const GATEWAY_INTENTS =
  INTENT_GUILDS | INTENT_GUILD_MESSAGES | INTENT_MESSAGE_CONTENT;

/* ---- close code ---- */

/**
 * **張り直しても直らない close code**（Discord のドキュメントの Reconnect = false 全部）。
 *
 * 計画 P4 §3-2 の表は 4004 と 4014 だけを挙げているが、**残りの 4 つも同じ性質**
 * （設定か実装が違うので、何回繋いでも同じところで切られる）。**張り続けると
 * identify のレート制限（1 日 1000 回）を静かに使い切る**（脅威 15）ので、
 * ドキュメントが「再接続不可」と言っている集合をそのまま `fatal` にする。
 */
const FATAL_CLOSE_CODES: readonly number[] = [
  4004, // token が不正
  4010, // shard の指定が不正
  4011, // sharding が必要
  4012, // API の版が不正
  4013, // intent の値が不正
  4014, // intent が Portal で有効になっていない
];

/**
 * **セッションが続かない close code。** 張り直すが `resume` はしない
 * （`seq` かセッションが無効になっているので、resume すると同じ理由で切られる）。
 */
const SESSION_LOST_CLOSE_CODES: readonly number[] = [
  4003, // identify の前に何か送った
  4005, // identify を 2 回送った
  4007, // resume の seq が不正
  4009, // セッションの寿命切れ
];

export const isFatalCloseCode = (code: number): boolean =>
  FATAL_CLOSE_CODES.includes(code);

/**
 * 自分から切るときの close code。**1000 を使わない** ——
 * 1000 は「もう戻らない」の意味で、Discord がセッションを即座に捨てる。
 */
export const GATEWAY_CLOSE_RESTART = 4000;

/* ---- 時間の定数 ---- */

/** `fetch` が返ってこない（ソケットが開かない）ときの上限。 */
export const GATEWAY_CONNECT_TIMEOUT_MS = 10_000;
/** ソケットは開いたが hello（op 10）が来ないときの上限。 */
export const GATEWAY_HELLO_TIMEOUT_MS = 30_000;
/** identify / resume を送ったが READY / RESUMED が来ないときの上限。 */
export const GATEWAY_READY_TIMEOUT_MS = 30_000;

export const GATEWAY_BACKOFF_BASE_MS = 5_000;
/** **上限を持つ**（脅威 15）。ここが無いと指数が伸び切って実質「諦め」になる。 */
export const GATEWAY_BACKOFF_MAX_MS = 10 * 60_000;
/** ジッタの幅。**乱数を使わない**（`backoffDelayMs` の why を参照）。 */
export const GATEWAY_BACKOFF_JITTER_MS = 1_000;

/** op 9 / op 7 のあとに置く間隔（仕様は「1〜5 秒待ってから」）。 */
export const GATEWAY_RESTART_WAIT_MS = 2_000;

/**
 * `POST /gateway/reset` を受け付ける最短間隔（plans/security.md 脅威 15）。
 *
 * **連打で identify のレート制限（1 日 1000 回）を使い切らせない。**
 * 画面のボタンでも `curl` でも同じ検査を通す。
 */
export const GATEWAY_RESET_INTERVAL_MS = 60_000;

/**
 * **ハートビート ACK が何回ぶん途切れたらゾンビとみなすか。**
 *
 * 仕様は「次のハートビートまでに ACK が来なければ切る」（＝ 1 回）だが、
 * **1 回の取りこぼしは一時的なこともある。** 2 回ぶん（既定の間隔で約 82 秒）待てば
 * 誤検知でむだな identify を使わずに済み、それでも「作業中」の窓（6 時間）より
 * 遥かに短いので素の文が長く止まることはない。
 */
const GATEWAY_ZOMBIE_HEARTBEATS = 2;

export const zombieWindowMs = (heartbeatIntervalMs: number): number =>
  heartbeatIntervalMs * GATEWAY_ZOMBIE_HEARTBEATS;

/**
 * 指数バックオフ ＋ ジッタ。**`attempt` は 1 から数える**（1 = 1 回目の張り直し）。
 *
 * **ジッタに乱数を使わない。** `step` が純粋でなくなると、この計画がわざわざ
 * 純粋関数に切った理由（要件 `F-I5`）が消える。時計の下位ミリ秒はそれ自体が
 * 実質のジッタなので `atMs % 幅` を足す —— **毎回同じ値にならない**ことだけが
 * 目的で、真の乱数性は要らない（散らす相手が居ない。接続は 1 本。要件 `I-9`）。
 */
export const backoffDelayMs = (attempt: number, atMs: number): number => {
  const grown = GATEWAY_BACKOFF_BASE_MS * 2 ** (Math.max(attempt, 1) - 1);
  return (
    Math.min(grown, GATEWAY_BACKOFF_MAX_MS) +
    (Math.max(atMs, 0) % GATEWAY_BACKOFF_JITTER_MS)
  );
};

/**
 * **`fetch` に `wss://` を渡さない。** `Fetch API cannot load: wss://…` で即座に
 * 落ち、ソケットが開かないので「原因不明で繋がらない」にしか見えない（計画 P4 §3-3）。
 *
 * `resume_gateway_url` はクエリを持たない形で来るので、**版とエンコーディングを
 * ここで付け直す** —— 付け忘れると Discord 側の既定の版に繋がる。
 */
export const gatewayConnectUrl = (raw: string): string => {
  const swapped = raw.startsWith("wss://")
    ? `https://${raw.slice("wss://".length)}`
    : raw.startsWith("ws://")
      ? `http://${raw.slice("ws://".length)}`
      : raw;

  /*
    **`new URL` を使わない。** このパッケージは `lib: ["ES2022"]` ／ `types: []` で
    閉じてある（`domain-is-pure` の 2 段目の防御）ので、`URL` は型として見えない ——
    `fire.ts` の `hostOf` が同じ理由で手で切っている。

    Discord から来た値が壊れていても**投げない。** 既定の宛先で張り直せば
    復帰できるが、ここで例外を出すと DO の遷移そのものが止まる。
  */
  const schemeEnd = swapped.indexOf("://");
  if (schemeEnd < 0) return DEFAULT_CONNECT_URL;

  const scheme = swapped.slice(0, schemeEnd);
  if (scheme !== "https" && scheme !== "http") return DEFAULT_CONNECT_URL;

  const rest = swapped.slice(schemeEnd + 3);
  const authorityEnd = rest.search(/[/?#]/);
  const authority = authorityEnd < 0 ? rest : rest.slice(0, authorityEnd);
  if (authority === "") return DEFAULT_CONNECT_URL;

  // **元のクエリは丸ごと捨てる**（古い `v=6` が残ると版が混ざる）。
  const path =
    authorityEnd < 0 ? "/" : (rest.slice(authorityEnd).split(/[?#]/)[0] ?? "/");

  return `${scheme}://${authority}${path === "" ? "/" : path}?${GATEWAY_QUERY}`;
};

/* ---- 状態と入力 ---- */

/** resume に要る 3 つ。**DO のメモリにだけ置く**（D1 にも DO storage にも書かない）。 */
export type GatewaySession = Readonly<{
  sessionId: string;
  resumeUrl: string;
  seq: number | null;
}>;

type HeartbeatClock = Readonly<{ intervalMs: number; nextAt: number }>;

/**
 * **`connecting` が `deadline` を持つのが要点。** 「ソケットが開かない」
 * 「hello が来ない」「READY が来ない」は別の失敗で上限も別なので、
 * 状態に残り時間を 1 本持たせて**入力ごとに張り替える**（`open` と `hello` の役目）。
 *
 * **`attempt` は `connecting` にも要る。** ここに無いと、backoff から出た瞬間に
 * 回数が 0 に戻って指数が伸びない（脅威 15 の「上限を持つ」が空振りする）。
 */
export type GatewayState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{
      kind: "connecting";
      deadline: number;
      attempt: number;
      heartbeat: HeartbeatClock | null;
      resume: GatewaySession | null;
    }>
  | Readonly<{
      kind: "live";
      session: GatewaySession;
      heartbeat: HeartbeatClock;
      lastEventAt: number;
    }>
  | Readonly<{
      kind: "backoff";
      until: number;
      attempt: number;
      resume: GatewaySession | null;
    }>
  | Readonly<{ kind: "fatal"; reason: string }>;

export type GatewayStateKind = GatewayState["kind"];

/**
 * **どの入力も `at` を持つ。** 計画の素案は `dispatch` と `tick` だけに付けていたが、
 * 遷移のたびに期限を張り替えるので**全部に要る** —— 呼ぶ側が時計を 1 か所
 * （`Date.now()`）から渡す形にしておけば、テストは時間を自由に作れる。
 */
export type GatewayInput =
  | Readonly<{ kind: "open"; at: number }>
  | Readonly<{ kind: "hello"; at: number; heartbeatIntervalMs: number }>
  | Readonly<{
      kind: "ready";
      at: number;
      sessionId: string;
      resumeUrl: string;
      seq: number;
    }>
  | Readonly<{ kind: "resumed"; at: number; seq: number }>
  | Readonly<{ kind: "dispatch"; at: number; seq: number }>
  | Readonly<{ kind: "ack"; at: number }>
  | Readonly<{ kind: "reconnect"; at: number }>
  | Readonly<{ kind: "invalidSession"; at: number; resumable: boolean }>
  | Readonly<{ kind: "close"; at: number; code: number }>
  | Readonly<{ kind: "tick"; at: number }>
  /**
   * **設定が足りないので張れない**（`DISCORD_BOT_TOKEN` が空など）。
   *
   * `fatal` に落とすのは、これも「人が直すまで直らない失敗」だから（要件 `F-I4`）。
   * 空の token で identify を投げ続けると 4004 でレート制限を使い切る（脅威 15）。
   */
  | Readonly<{ kind: "misconfigured"; at: number; reason: string }>
  | Readonly<{ kind: "reset"; at: number }>;

/**
 * 副作用を**値で返す**（Functional Core）。
 *
 * `identify` / `resume` / `heartbeat` が「送るもの」を名前で表すだけなのは、
 * bot token をこの層へ持ち込まないため（脅威 15）。
 */
export type GatewayEffect =
  | Readonly<{ kind: "connect"; url: string }>
  | Readonly<{ kind: "identify" }>
  | Readonly<{ kind: "resume"; sessionId: string; seq: number | null }>
  | Readonly<{ kind: "heartbeat"; seq: number | null }>
  | Readonly<{ kind: "disconnect"; code: number; reason: string }>
  /** **`atMs: null` は「alarm を消す」。** `fatal` は自分から起きない（要件 `F-I4`）。 */
  | Readonly<{ kind: "alarm"; atMs: number | null }>;

export type GatewayStep = Readonly<{
  next: GatewayState;
  effects: readonly GatewayEffect[];
}>;

/**
 * 次に起きる時刻。**alarm は 1 つしか張れない**ので、いちばん早い期限に合わせる。
 *
 * `idle` と `fatal` が `null` を返すのが効いている —— `fatal` で alarm を残すと
 * 「張り直さない」が守れず、`idle` は cron の `/ensure` が起こす側にある。
 */
const nextWakeAt = (state: GatewayState): number | null => {
  switch (state.kind) {
    case "idle":
      return null;
    case "connecting":
      return state.heartbeat === null
        ? state.deadline
        : Math.min(state.deadline, state.heartbeat.nextAt);
    case "live":
      return Math.min(
        state.heartbeat.nextAt,
        state.lastEventAt + zombieWindowMs(state.heartbeat.intervalMs),
      );
    case "backoff":
      return state.until;
    case "fatal":
      return null;
  }
};

/** **alarm の張り替えを忘れられないようにする**（`step` の出口を 1 つに絞る）。 */
const settle = (
  next: GatewayState,
  effects: readonly GatewayEffect[] = [],
): GatewayStep => ({
  next,
  effects: [...effects, { kind: "alarm", atMs: nextWakeAt(next) }],
});

const before = (
  effects: readonly GatewayEffect[],
  onward: GatewayStep,
): GatewayStep => ({
  next: onward.next,
  effects: [...effects, ...onward.effects],
});

const disconnect = (reason: string): GatewayEffect => ({
  kind: "disconnect",
  code: GATEWAY_CLOSE_RESTART,
  reason,
});

const startConnecting = (
  at: number,
  attempt: number,
  resume: GatewaySession | null,
): GatewayStep =>
  settle(
    {
      kind: "connecting",
      deadline: at + GATEWAY_CONNECT_TIMEOUT_MS,
      attempt,
      heartbeat: null,
      resume,
    },
    [
      {
        kind: "connect",
        url: gatewayConnectUrl(resume?.resumeUrl ?? GATEWAY_URL),
      },
    ],
  );

const startBackoff = (
  at: number,
  attempt: number,
  resume: GatewaySession | null,
  delayMs: number = backoffDelayMs(attempt, at),
): GatewayStep =>
  settle({ kind: "backoff", until: at + delayMs, attempt, resume });

/** その状態が resume に使えるセッションを持っているか。 */
const sessionOf = (state: GatewayState): GatewaySession | null => {
  switch (state.kind) {
    case "live":
      return state.session;
    case "connecting":
    case "backoff":
      return state.resume;
    case "idle":
    case "fatal":
      return null;
  }
};

/** ここまでに何回失敗したか。**`live` からの切断は 0 回目**（待たせすぎない）。 */
const failuresOf = (state: GatewayState): number => {
  switch (state.kind) {
    case "connecting":
    case "backoff":
      return state.attempt;
    case "live":
    case "idle":
    case "fatal":
      return 0;
  }
};

/** `fatal` の理由。**P7b の運用画面が直し方の文言へ引き当てる鍵**になる。 */
export const closeReason = (code: number): string => `close_${code}`;

/**
 * 状態遷移の**唯一の**場所（計画 P4 §3-2）。
 *
 * **`fatal` からは `reset` だけが出られる。** それ以外の入力を全部落とすのが
 * 要件 `F-I4`（「復帰は人が reset を叩く」）の実装そのもの。
 */
export const step = (state: GatewayState, input: GatewayInput): GatewayStep => {
  if (input.kind === "reset") {
    /*
      **resume を捨てて素の identify から始める。** 人が reset を叩いたのは
      「いまの状態が信用できない」からなので、そこへセッションを持ち込まない。
    */
    return before([disconnect("reset")], startConnecting(input.at, 0, null));
  }

  if (input.kind === "misconfigured") {
    return before(
      [disconnect(input.reason)],
      settle({ kind: "fatal", reason: input.reason }),
    );
  }

  if (state.kind === "fatal") return settle(state);

  switch (input.kind) {
    case "tick":
      return onTick(state, input.at);

    case "open":
      /*
        ソケットが開いた。**期限を「hello を待つ」側へ張り替える。**
        ここで張り替えないと握手の全体を 1 つの上限で見ることになり、
        「そもそも開かない」と「開いたのに黙っている」が区別できなくなる。
      */
      return state.kind === "connecting"
        ? settle({ ...state, deadline: input.at + GATEWAY_HELLO_TIMEOUT_MS })
        : settle(state);

    case "hello": {
      if (state.kind !== "connecting") return settle(state);
      /*
        **ジッタを入れずに 1 間隔ぶん待つ。** 仕様は初回だけ `interval * 乱数` を
        勧めているが、あれは大量のシャードが同時に張り直すのを散らすためのもので、
        **接続が 1 本しかない offdesk には散らす相手が居ない**（要件 `I-9`）。
      */
      return settle(
        {
          ...state,
          deadline: input.at + GATEWAY_READY_TIMEOUT_MS,
          heartbeat: {
            intervalMs: input.heartbeatIntervalMs,
            nextAt: input.at + input.heartbeatIntervalMs,
          },
        },
        [
          state.resume === null
            ? { kind: "identify" }
            : {
                kind: "resume",
                sessionId: state.resume.sessionId,
                seq: state.resume.seq,
              },
        ],
      );
    }

    case "ready":
      /*
        **hello を受ける前の READY は受け取らない。** ハートビートの間隔が
        分からないまま `live` にすると、送る周期を推測することになる。
        期限（`deadline`）が来て張り直すので行き止まりにはならない。
      */
      return state.kind === "connecting" && state.heartbeat !== null
        ? settle({
            kind: "live",
            session: {
              sessionId: input.sessionId,
              resumeUrl: input.resumeUrl,
              seq: input.seq,
            },
            heartbeat: state.heartbeat,
            lastEventAt: input.at,
          })
        : settle(state);

    case "resumed":
      return state.kind === "connecting" &&
        state.heartbeat !== null &&
        state.resume !== null
        ? settle({
            kind: "live",
            session: { ...state.resume, seq: input.seq },
            heartbeat: state.heartbeat,
            lastEventAt: input.at,
          })
        : settle(state);

    case "dispatch":
      if (state.kind === "live") {
        return settle({
          ...state,
          session: { ...state.session, seq: input.seq },
          lastEventAt: input.at,
        });
      }
      /*
        **resume の取りこぼし分は RESUMED より先に流れてくる**（仕様）。
        ここで `seq` を進めておかないと、次の resume が古い `seq` を送って
        4007（invalid seq）で切られる。期限も一緒に延ばす（再生は時間がかかる）。
      */
      return state.kind === "connecting" && state.resume !== null
        ? settle({
            ...state,
            deadline: input.at + GATEWAY_READY_TIMEOUT_MS,
            resume: { ...state.resume, seq: input.seq },
          })
        : settle(state);

    case "ack":
      /*
        **ACK も「生きている」の証拠として数える。** 静かなサーバーでは
        `MESSAGE_CREATE` が何時間も来ないので、dispatch だけを見ていると
        正常な接続がゾンビ判定される。
      */
      return state.kind === "live"
        ? settle({ ...state, lastEventAt: input.at })
        : settle(state);

    case "reconnect":
      /*
        op 7 = Discord からの「張り直して resume して」。**失敗ではない**ので
        バックオフの回数を増やさず、仕様どおり短い間隔だけ置く。
      */
      return before(
        [disconnect("op 7 reconnect")],
        startBackoff(
          input.at,
          failuresOf(state),
          sessionOf(state),
          GATEWAY_RESTART_WAIT_MS,
        ),
      );

    case "invalidSession":
      /*
        op 9。`d: true` なら resume できる／`false` なら**セッションを捨てて
        identify から**（捨てずに resume すると同じ理由でまた切られる）。
      */
      return before(
        [disconnect("op 9 invalid session")],
        startBackoff(
          input.at,
          failuresOf(state),
          input.resumable ? sessionOf(state) : null,
          GATEWAY_RESTART_WAIT_MS,
        ),
      );

    case "close":
      if (isFatalCloseCode(input.code)) {
        // **張り直さない**（要件 `F-I4`・脅威 15）。alarm も消える（`nextWakeAt`）。
        return settle({ kind: "fatal", reason: closeReason(input.code) });
      }
      return startBackoff(
        input.at,
        failuresOf(state) + 1,
        SESSION_LOST_CLOSE_CODES.includes(input.code) ? null : sessionOf(state),
      );
  }
};

const onTick = (state: GatewayState, at: number): GatewayStep => {
  switch (state.kind) {
    case "idle":
      return startConnecting(at, 0, null);

    case "backoff":
      return at >= state.until
        ? startConnecting(at, state.attempt, state.resume)
        : settle(state);

    case "connecting": {
      if (at >= state.deadline) {
        return before(
          [disconnect("握手が終わらない")],
          startBackoff(at, state.attempt + 1, state.resume),
        );
      }
      if (state.heartbeat !== null && at >= state.heartbeat.nextAt) {
        return settle(
          {
            ...state,
            heartbeat: {
              ...state.heartbeat,
              nextAt: at + state.heartbeat.intervalMs,
            },
          },
          [{ kind: "heartbeat", seq: state.resume?.seq ?? null }],
        );
      }
      return settle(state);
    }

    case "live": {
      /*
        **ゾンビの検査をハートビートより先に置く。** 逆にすると、返事の来ない
        ソケットへ延々とハートビートを撃ち続けて、`lastEventAt` が古いまま
        「送れているから生きている」ように見える。
      */
      if (
        at - state.lastEventAt >=
        zombieWindowMs(state.heartbeat.intervalMs)
      ) {
        return before(
          [disconnect("ACK が途切れた（ゾンビ接続）")],
          startBackoff(at, 1, state.session),
        );
      }
      if (at >= state.heartbeat.nextAt) {
        /*
          **次回を `at + interval` にする**（`nextAt + interval` にしない）。
          DO が evict されて alarm が遅れた場合、遅れた分を取り戻そうとして
          ハートビートを連続で撃つ形になり、4008（rate limited）で切られる。
        */
        return settle(
          {
            ...state,
            heartbeat: {
              ...state.heartbeat,
              nextAt: at + state.heartbeat.intervalMs,
            },
          },
          [{ kind: "heartbeat", seq: state.session.seq }],
        );
      }
      return settle(state);
    }

    case "fatal":
      return settle(state);
  }
};

/**
 * 「素の文がいま届く状態か」。**`live` だけでは足りない** ——
 * ACK が途切れかけているソケットは `live` のまま黙る。
 */
export const isGatewayHealthy = (state: GatewayState, at: number): boolean =>
  state.kind === "live" &&
  at - state.lastEventAt < zombieWindowMs(state.heartbeat.intervalMs);

/* ---- フレームの読み方（計画 P4 §3-3「判定を DO に書かない」の延長） ---- */

/**
 * 受け取ったフレームから何をするか。
 *
 * **DO に振り分けを書かない。** ソケットを張るテストは書けない
 * （`WebSocketPair` は DO の I/O 文脈を越えられない。2026-09-04 に実測）ので、
 * **DO に置いたものは一切テストできない** —— だから読み方をここへ出す。
 * DO に残るのは「開く / 閉じる / 送る」と「alarm を張る」だけになる。
 */
export type GatewayFrameAction =
  /** 状態遷移へ渡す。 */
  | Readonly<{ kind: "input"; input: GatewayInput }>
  /** op 1。**周期とは無関係に、いますぐ返す**（`step` を通すと次の周期がずれる）。 */
  | Readonly<{ kind: "beat" }>
  /** `MESSAGE_CREATE`。`applyInbound` へ渡す。 */
  | Readonly<{ kind: "message"; message: InboundMessage }>;

type RawFrame = {
  readonly op?: unknown;
  readonly d?: unknown;
  readonly s?: unknown;
  readonly t?: unknown;
};

const recordOf = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ...value }
    : {};

const textOf = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

/**
 * 生のフレーム（JSON 文字列）を読む。
 *
 * **投げない。** 壊れたフレーム 1 つで常駐接続が落ちると、素の文が届かなくなる ——
 * 読めないものは空配列（＝ 何もしない）に倒す。仕様が増えて知らない `op` が
 * 来たときも同じ。
 *
 * `MESSAGE_CREATE` だけ**2 つ返す** —— `seq` を進める `dispatch` と、
 * 本文を渡す `message`。片方だけにすると、`seq` が止まって次の resume が
 * 4007（invalid seq）で切られる。
 */
export const parseGatewayFrame = (
  raw: string,
  at: number,
): readonly GatewayFrameAction[] => {
  let frame: RawFrame;
  try {
    frame = recordOf(JSON.parse(raw));
  } catch {
    return [];
  }

  const op = typeof frame.op === "number" ? frame.op : -1;

  switch (op) {
    case GATEWAY_OP.hello: {
      const interval = recordOf(frame.d).heartbeat_interval;
      // 間隔が分からないまま進むと、送る周期を推測することになる。
      if (typeof interval !== "number" || interval <= 0) return [];
      return [
        {
          kind: "input",
          input: { kind: "hello", at, heartbeatIntervalMs: interval },
        },
      ];
    }

    case GATEWAY_OP.heartbeatAck:
      return [{ kind: "input", input: { kind: "ack", at } }];

    case GATEWAY_OP.heartbeat:
      return [{ kind: "beat" }];

    case GATEWAY_OP.reconnect:
      return [{ kind: "input", input: { kind: "reconnect", at } }];

    case GATEWAY_OP.invalidSession:
      return [
        {
          kind: "input",
          // `d` が `true` なら resume できる。**`true` 以外は全部「できない」。**
          input: { kind: "invalidSession", at, resumable: frame.d === true },
        },
      ];

    case GATEWAY_OP.dispatch:
      return dispatchActions(frame, at);

    default:
      return [];
  }
};

const dispatchActions = (
  frame: RawFrame,
  at: number,
): readonly GatewayFrameAction[] => {
  const seq = typeof frame.s === "number" ? frame.s : 0;
  const d = recordOf(frame.d);

  if (frame.t === "READY") {
    const sessionId = textOf(d.session_id);
    const resumeUrl = textOf(d.resume_gateway_url);
    // 揃っていないと resume ができない形になる。期限が来て張り直す。
    if (sessionId === null || resumeUrl === null) return [];
    return [
      {
        kind: "input",
        input: { kind: "ready", at, sessionId, resumeUrl, seq },
      },
    ];
  }

  if (frame.t === "RESUMED") {
    return [{ kind: "input", input: { kind: "resumed", at, seq } }];
  }

  const dispatch: GatewayFrameAction = {
    kind: "input",
    input: { kind: "dispatch", at, seq },
  };

  if (frame.t !== "MESSAGE_CREATE") return [dispatch];

  const author = recordOf(d.author);
  const messageId = textOf(d.id);
  const channelId = textOf(d.channel_id);
  const authorId = textOf(author.id);
  // 形が足りないフレームは `seq` だけ進める（本文が誰のものか分からない）。
  if (messageId === null || channelId === null || authorId === null) {
    return [dispatch];
  }

  return [
    dispatch,
    {
      kind: "message",
      message: {
        messageId,
        channelId,
        authorId,
        authorIsBot: author.bot === true,
        content: typeof d.content === "string" ? d.content : "",
      },
    },
  ];
};
