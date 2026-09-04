/** 1 回の握りの長さ。ここを超えたら `pending` を返して `ask_wait` に引き継ぐ（要件 `F-B2`）。 */
export const ASK_HOLD_MS = 15 * 60_000;

/** 回答が入ったかを見に行く間隔。D1 を 1 回引くだけなので CPU はほぼ使わない。 */
export const ASK_POLL_MS = 3_000;

/**
 * progress 通知の間隔。**エッジの限界より内側**であることが握りの前提。
 *
 * SSE のコメント行（`: ping`）は JSON-RPC メッセージではないので、
 * **クライアント側の idle の時計は止まらない。** 止められるのは progress 通知だけ。
 */
export const ASK_PROGRESS_MS = 20_000;

/**
 * `progressToken` が無く、クライアントから見て**完全な沈黙**になるときの上限。
 *
 * 黙って abort されると `ask_id` を含まないエラーになる。先に自分から `pending` を
 * 返して降りれば `ask_wait` で拾い直せるので、答えも往復も失われない（要件 `F-B6`）。
 */
export const ASK_SILENT_HOLD_MS = 4 * 60_000;

/** `runs.held_at`（握りのハートビート）を更新する間隔（要件 `F-C5`）。 */
export const ASK_TOUCH_MS = 15_000;

/**
 * `held_at` がこれより新しければ「握りが生きている」とみなす（要件 `F-C5`・`F-C6`）。
 *
 * **`ASK_TOUCH_MS` の 2 回ぶんより広く取る。** 1 回の更新に失敗しただけで
 * 「死んだ」と判定すると、生きている握りの上に 2 本目が乗る（脅威 16）。
 */
export const HELD_ALIVE_MS = 60_000;

/** 応答が始まらないまま握るとエッジが 502 を返す（kanata の実測値）。 */
export const OBSERVED_EDGE_CUTOFF_MS = 75_000;

/**
 * **クライアント（Claude Code）が無音のツール呼び出しを打ち切る既定。**
 * v2.1.187 以降。`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` で変えられるが既定は 5 分。
 */
export const CLIENT_IDLE_ABORT_MS = 5 * 60_000;

/**
 * cloud environment に置く `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` の推奨値（計画 P3a §1）。
 * **`ASK_HOLD_MS` より大きくないと、握りの上限に達する前にクライアントが切る。**
 */
export const RECOMMENDED_CLIENT_IDLE_TIMEOUT_MS = 60 * 60_000;

export type HoldConfig = {
  readonly holdMs: number;
  readonly pollMs: number;
  readonly progressMs: number;
  readonly silentHoldMs: number;
  readonly touchMs: number;
};

/** 環境変数の生の値。**「無い」は `undefined`、不正な値も既定に倒す。** */
export type HoldOverrides = {
  readonly ASK_HOLD_MS?: string;
  readonly ASK_POLL_MS?: string;
  readonly ASK_PROGRESS_MS?: string;
  readonly ASK_SILENT_HOLD_MS?: string;
  readonly ASK_TOUCH_MS?: string;
};

/**
 * **正の有限な数だけを採る。** `Number("")` は 0、`Number("abc")` は NaN なので、
 * 素直に `Number(raw) || fallback` と書くと 0 が既定に化けて「0 も通る」と誤解される。
 * ここで落とす値を明示しておけば、テストがそれを固められる。
 */
const positive = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback;
  const value = Number(raw.trim());
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/**
 * **待ちの長さは設定で縮められる**（要件 `N-9`）。時間で待つテストを書かないための口で、
 * テストでは数十ミリ秒にする。
 */
export const resolveHoldConfig = (
  overrides: HoldOverrides = {},
): HoldConfig => ({
  holdMs: positive(overrides.ASK_HOLD_MS, ASK_HOLD_MS),
  pollMs: positive(overrides.ASK_POLL_MS, ASK_POLL_MS),
  progressMs: positive(overrides.ASK_PROGRESS_MS, ASK_PROGRESS_MS),
  silentHoldMs: positive(overrides.ASK_SILENT_HOLD_MS, ASK_SILENT_HOLD_MS),
  touchMs: positive(overrides.ASK_TOUCH_MS, ASK_TOUCH_MS),
});

/**
 * この握りを何ミリ秒まで続けてよいか。
 *
 * **`progressToken` が無いと沈黙の上限に落とす。** SSE のコメント行では
 * クライアント側の時計が止まらないので、上限まで握ると黙って切られる。
 */
export const holdLimitMs = (
  config: HoldConfig,
  hasProgressToken: boolean,
): number =>
  hasProgressToken
    ? config.holdMs
    : Math.min(config.holdMs, config.silentHoldMs);

/**
 * その run の握りは**まだ生きているか**（要件 `F-C5`）。
 *
 * **`heldAt` が無い（一度も握られていない）なら生きていない。** ここを true に倒すと
 * 最初の `ask_human` が自分自身に譲って永久に握れない。
 */
export const isHeldAlive = (
  heldAtMs: number | null,
  nowMs: number,
  windowMs: number = HELD_ALIVE_MS,
): boolean => heldAtMs !== null && nowMs - heldAtMs < windowMs;
