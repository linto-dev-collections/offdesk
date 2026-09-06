import { z } from "zod";

/*
  Claude Code の hook が送ってくる形（計画 P5 §3-3・§3-4）。

  **転写ログの中身は 1 文字も来ない**（脅威 12）。来るのは使用量の数値と
  モデル名だけで、`transcript_path` すら送らない —— ローカルのファイルパスは
  offdesk 側で使い道がなく、送れば漏れる情報が増えるだけ。

  **契約をここに置く理由は、送る側がシェルスクリプトだから。**
  `plugin/plugins/offdesk/hooks/offdesk-hook.sh` は cloud session の中で走る
  bash で、型で縛れない。**受け側で閉じておくのが唯一の防具。**
*/

/**
 * 「無いか NULL」を 0 に倒す。
 *
 * **`.default(0)` では足りない。** あれが効くのは `undefined` のときだけで、
 * Anthropic の usage は `cache_creation_input_tokens` を**明示的に `null`** で
 * 返すことがある（キャッシュを使わなかったターン）。`null` が来ると
 * `.default(0)` は素通りせず型エラーになり、**通報ごと落ちる。**
 */
const tokenCount = z
  .number()
  .int()
  .min(0)
  .nullish()
  .transform((value) => value ?? 0);

/**
 * `.message.usage` をそのまま。**鍵は転写ログの名前のまま**にしてある ——
 * hook スクリプトが `jq` で抜いたオブジェクトを加工せずに載せられるので、
 * 名前を変える側（＝ズレる余地）が 1 つ減る。
 */
const HookUsage = z.object({
  input_tokens: tokenCount,
  cache_creation_input_tokens: tokenCount,
  cache_read_input_tokens: tokenCount,
  output_tokens: tokenCount,
});

/**
 * `POST /hooks/context`（`PreToolUse` と `Stop`）。
 *
 * **`event` を受け取るのは `Stop` を区別するためだけ**（`events` に 1 行残す）。
 * **`Stop` で状態は変えない**（要件 `F-D6`・`I-11`）。
 */
export const HookContextInput = z.object({
  run_key: z.string().min(1),
  event: z.enum(["PreToolUse", "Stop"]),
  /**
   * 分母を引く鍵。**無いこともある**ので必須にしない ——
   * `.message.usage` があって `.message.model` が無い行はありうるし、
   * そこで弾くと**分子ごと捨てることになる。**
   */
  model: z.string().min(1).nullish(),
  usage: HookUsage,
});
export type HookContextInput = z.infer<typeof HookContextInput>;

/** `POST /hooks/session-end`。**終了だけを伝える**ので `run_key` 以外を持たない。 */
export const HookSessionEndInput = z.object({
  run_key: z.string().min(1),
});
export type HookSessionEndInput = z.infer<typeof HookSessionEndInput>;
