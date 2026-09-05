/**
 * cron の文字列（要件 `F-I2`・`F-I6`・計画 P8 §3-1）。
 *
 * **同じ値が 3 か所にある** —— ここ・`apps/app/wrangler.jsonc`（ローカル）・
 * `packages/infra/alchemy.run.ts`（本番）。食い違うと `scheduled` が
 * **どの分岐にも入らず何も起きない**（例外も出ないので、気づく手段が無い）。
 * `apps/app/test/release/cron-consistency.test.ts` が 3 つを突き合わせる。
 *
 * **時刻は UTC。** 5 分ごとなので JST の考慮は要らない。
 */
export const CRON_EVERY_5_MIN = "*/5 * * * *";

/** 登録している cron の全部。**増やしたら 3 か所に足す。** */
export const CRONS = [CRON_EVERY_5_MIN] as const;
