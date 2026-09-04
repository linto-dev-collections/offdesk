import { z } from "zod";

/**
 * Gateway の状態（要件 `F-I7`・計画 P4 §3-7）。
 *
 * **`GET /gateway/status`（Bearer）と P7b の運用画面（oRPC）が同じ形を出す。**
 * 契約をここに置いてあるのは、`curl` で見る形と画面で見る形が
 * 食い違わないようにするため —— 食い違うと「画面では live なのに curl では違う」
 * を切り分けることになる。
 *
 * **bot token に到達する値を 1 つも持たない**（脅威 15）。デバッグ情報を
 * 足したくなる場所なので、スキーマの側で「持てるもの」を閉じておく。
 */
export const GatewayStatus = z.object({
  state: z.enum(["idle", "connecting", "live", "backoff", "fatal"]),
  /** 「素の文がいま届くか」。**`state === "live"` とは一致しない**（無音の深さも見る）。 */
  healthy: z.boolean(),
  /** `close_4014` のような鍵。**文言ではなく鍵**（下の `gatewayFatalHint` が引く）。 */
  fatalReason: z.string().nullable(),
  lastEventAt: z.number().int().nullable(),
  /** ソケットが開いているか（状態とは別に持つ。`connecting` でも開いていることがある）。 */
  connected: z.boolean(),
  /** 60 秒の間隔をクライアントに伝える（`null` = いま叩ける）。 */
  resetAvailableAt: z.number().int().nullable(),
});
export type GatewayStatus = z.infer<typeof GatewayStatus>;

/**
 * `fatal` のときに人へ出す**直し方**（計画 P4 §3-7・P7b §3-3）。
 *
 * **文言をサーバーとクライアントで別々に書かない。** どちらも `fatalReason` の
 * 鍵からここを引く —— `fatal` は「人が直すまで戻らない」状態なので、
 * **何をすれば戻るのかが出ていないと詰む。**
 */
const FATAL_HINTS: Readonly<Record<string, string>> = {
  no_token:
    "DISCORD_BOT_TOKEN が設定されていません。Worker の secret に入れてから /gateway/reset を叩いてください。",
  close_4004:
    "bot token が違います。Developer Portal で Reset Token し、DISCORD_BOT_TOKEN を入れ直してください。",
  close_4014:
    "MESSAGE CONTENT INTENT が有効になっていません。Developer Portal の Bot ページで on にしてください。",
  close_4013:
    "要求している intent の値が不正です（GATEWAY_INTENTS を確認してください）。",
  close_4012:
    "Gateway の API 版が不正です（接続 URL の v= を確認してください）。",
  close_4010: "shard の指定が不正です。",
  close_4011:
    "サーバー数が 1 接続の上限を超えています（sharding が必要です）。",
};

export const gatewayFatalHint = (reason: string | null): string | null => {
  if (reason === null) return null;
  return (
    FATAL_HINTS[reason] ??
    `${reason} で切られました。原因を直してから /gateway/reset を叩いてください。`
  );
};
