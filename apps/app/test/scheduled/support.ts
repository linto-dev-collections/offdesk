import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import worker from "../../src/worker/index.ts";
import { CRON_EVERY_5_MIN } from "../../src/worker/scheduled/crons.ts";

/*
  cron を叩くための道具（計画 P8 §5）。

  **`worker.scheduled` を通す。** 個別の関数を直に呼ぶと、`event.cron` の
  振り分けと `waitUntil` の載せ方が検査から外れる —— あそこが P8 の
  いちばん静かに壊れるところ（どの分岐にも入らないと例外も出ない）。

  **`waitOnExecutionContext` を必ず待つ。** 3 つの仕事は `waitUntil` の中で
  走るので、待たずに検査すると書き込みの途中を見る。
*/

export const runCron = async (
  overrides: {
    readonly cron?: string;
    readonly env?: Partial<typeof env>;
  } = {},
): Promise<void> => {
  const ctx = createExecutionContext();
  const controller = createScheduledController({
    cron: overrides.cron ?? CRON_EVERY_5_MIN,
    scheduledTime: new Date(),
  });

  await worker.scheduled(controller, { ...env, ...overrides.env }, ctx);
  await waitOnExecutionContext(ctx);
};
