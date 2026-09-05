import {
  createDb,
  failQueuedRun,
  insertEvent,
  listStaleQueuedRuns,
} from "@offdesk/db";
import { sweepQueuedRuns } from "@offdesk/usecase";
import type { WorkerEnv } from "../env.ts";

/*
  起動が完了しなかった run を畳む（要件 `F-I6`・計画 P8 §3-2）。

  **Discord には出さない**（要件 §3-2 の「通知は作らない」）。気づく手段は画面で、
  `events` の 1 行が run 詳細の時系列に並ぶ。
*/

export const sweepStaleQueuedRuns = async (env: WorkerEnv): Promise<void> => {
  const db = createDb(env.DB);

  const { swept, raced } = await sweepQueuedRuns({
    store: {
      listStale: (before, limit) => listStaleQueuedRuns(db, before, limit),
      fail: (runKey, reason) => failQueuedRun(db, runKey, reason, Date.now()),
      record: async (runKey, body) => {
        await insertEvent(db, { runKey, kind: "error", body }, Date.now());
      },
    },
    nowMs: Date.now(),
  });

  /*
    **`run_key` だけを出す**（脅威 12）。`prompt` は依頼者が書いた本文なので、
    ログに載せる理由が無い。
  */
  if (swept.length > 0) {
    console.warn("[cron] 起動が完了しなかった run を畳みました", {
      count: swept.length,
      runKeys: swept,
    });
  }

  /*
    **負けた分も出す。** `queued` のまま 10 分を超えたのに動き出していた
    ＝ 起動がとても遅い、という合図で、閾値を見直す材料になる。
  */
  if (raced.length > 0) {
    console.warn("[cron] 畳む前に動き出していた run があります", {
      count: raced.length,
      runKeys: raced,
    });
  }
};
