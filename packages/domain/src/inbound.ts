import { HELD_ALIVE_MS, isHeldAlive } from "./hold.ts";

/*
  素の文が届いたときの 4 通りの判定（要件 `F-C2`・計画 P4 §3-4）。

  **判定は 1 つだけが持つ。** `/offdesk`（P2 の interaction 経路）も Gateway 経路も
  同じ関数を通る —— 2 か所に分かれた瞬間に「コマンドだと起こし直すのに、素の文だと
  溜まる」のような食い違いが出る。

  **迷ったら溜める側へ倒す**（要件 `F-C6`）。外し方の代償が非対称だから ——
  溜めすぎは「届かない」で取り返せるが、起こしすぎは「2 本立つ」で取り返せない。
*/

/**
 * 「握りが生きている」窓（要件 `F-C5`）。**握りが 15 秒ごとに更新する印**を見るので短い。
 * 値は握り側と同じもの（`HELD_ALIVE_MS`）—— **2 か所に別の数字を置かない。**
 */
export const INBOUND_HELD_WINDOW_MS = HELD_ALIVE_MS;

/**
 * 「作業中」の窓（要件 `F-C6`）。**数時間開く。**
 *
 * 実装中の Claude は誰にも何も言わないので、握りと同じ窓（60 秒）で見ると
 * **「20 分黙って実装している最中の 1 行」で 2 本目の run が立つ。**
 */
export const INBOUND_ACTIVE_WINDOW_MS = 6 * 60 * 60_000;

export type InboundWindows = Readonly<{
  heldMs: number;
  activeMs: number;
}>;

/** 環境変数の生の値。**「無い」は `undefined`、不正な値も既定に倒す。** */
export type InboundOverrides = Readonly<{
  INBOUND_HELD_WINDOW_MS?: string;
  INBOUND_ACTIVE_WINDOW_MS?: string;
}>;

const positive = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback;
  const value = Number(raw.trim());
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/** **窓の長さは設定で縮められる**（要件 `N-9`）。テストが時間で待たずに済むための口。 */
export const resolveInboundWindows = (
  overrides: InboundOverrides = {},
): InboundWindows => ({
  heldMs: positive(overrides.INBOUND_HELD_WINDOW_MS, INBOUND_HELD_WINDOW_MS),
  activeMs: positive(
    overrides.INBOUND_ACTIVE_WINDOW_MS,
    INBOUND_ACTIVE_WINDOW_MS,
  ),
});

/**
 * 判定に要る run の姿。
 *
 * **`status` の語彙を domain に持ち込まない。** 終端かどうかだけを `terminal` で
 * 受ける（判定は `@offdesk/db` の `isTerminalStatus`）—— 一覧を 2 か所に置くと、
 * 状態を 1 つ足したときに片方だけが古くなる。
 */
export type RunSnapshot = Readonly<{
  terminal: boolean;
  /** 握りのハートビート（短い窓）。 */
  heldAt: number | null;
  /** Claude 由来の信号（長い窓）。 */
  activityAt: number | null;
  /**
   * 起動時刻。**これが要る。** 起動直後の run は `activity_at` も `held_at` も
   * NULL なので、その 2 つだけを見ると**起動 5 秒後の 1 行で 2 本目が立つ。**
   */
  createdAt: number;
}>;

/**
 * Gateway の `MESSAGE_CREATE` から、判定に要るものだけを抜いた形。
 *
 * **domain に置く。** 生のフレームを読むのは `parseGatewayFrame`（純粋関数）で、
 * その出口の型がここ —— worker 側に置くと、フレームの読み方を
 * ソケット無しでテストできなくなる（計画 P4 §3-3 が DO に判定を持たせない理由と同じ）。
 */
export type InboundMessage = Readonly<{
  messageId: string;
  /** 書かれた場所。**スレッド id**（親チャンネルなら run が引けないので `ignore`）。 */
  channelId: string;
  authorId: string;
  authorIsBot: boolean;
  content: string;
}>;

export type InboundDecision =
  /** offdesk の会話ではない。**何も出さない**（要件 `F-C2` の 4 行目）。 */
  | Readonly<{ kind: "ignore" }>
  /** 待っている質問がある → その問いへの回答になる。 */
  | Readonly<{ kind: "answer"; askId: string }>
  /** 作業中 → 預かる（`inbox`）。 */
  | Readonly<{ kind: "queue" }>
  /** 終わっている / 落ちている → 新しい run を起こす。 */
  | Readonly<{ kind: "restart" }>;

/**
 * **Claude が息をしていた最後の時刻。**
 *
 * 3 つの最大を採るのは、どれも「offdesk が Claude と繋がっていた証拠」だから ——
 * 握っていた（`held_at`）／報告が来た（`activity_at`）／起動した（`created_at`）。
 */
const lastSignAt = (run: RunSnapshot): number =>
  Math.max(run.createdAt, run.activityAt ?? 0, run.heldAt ?? 0);

export const decideInbound = (input: {
  readonly run: RunSnapshot | null;
  readonly pendingAsk: { readonly askId: string } | null;
  readonly now: number;
  readonly windows?: InboundWindows;
}): InboundDecision => {
  const { run, pendingAsk, now } = input;
  const windows = input.windows ?? resolveInboundWindows();

  // そのスレッドに run が無い（＝ offdesk が立てたスレッドではない）。
  if (run === null) return { kind: "ignore" };

  /*
    **終端は必ず起こし直す。** ここを窓の判定より先に置くのが要点 ——
    `done` になった直後の run は `activity_at` が新しいので、順番を逆にすると
    「終わった run に溜め続けて誰にも届かない」になる。
  */
  if (run.terminal) return { kind: "restart" };

  /*
    **未回答の問いがあり、かつ握りが生きている**ときだけ回答にする（要件 `F-C5`）。

    握りが死んでいるのに回答へ倒すと、落ちた run の未回答の問いが
    **以後そのスレッドの発言を永久に飲み込む穴**になる。
    そのときは下の「作業中」に落ちて `inbox` に溜まり、Claude が
    `ask_human` を呼び直した時点で渡る（P3b の拾い直しと同じ道）。
  */
  if (pendingAsk !== null && isHeldAlive(run.heldAt, now, windows.heldMs)) {
    return { kind: "answer", askId: pendingAsk.askId };
  }

  /*
    **作業中は長い窓で見る**（要件 `F-C6`）。握りの窓（60 秒）で判定すると、
    実装に集中している最中の 1 行が `restart` になって 2 本目が立つ。
  */
  if (now - lastSignAt(run) < windows.activeMs) return { kind: "queue" };

  return { kind: "restart" };
};

/**
 * 溜めていた文と今回の文を 1 つの指示に畳む（要件 `F-C2` の 3 行目）。
 *
 * **空行 1 つで繋ぐだけで、見出しも番号も付けない。** 依頼者が書いたそのままが
 * 指示なので、offdesk の言葉を混ぜると Claude がそれを指示として読む。
 */
export const foldInboundLines = (lines: readonly string[]): string =>
  lines
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("\n\n");
