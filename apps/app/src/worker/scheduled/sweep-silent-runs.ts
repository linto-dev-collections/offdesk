import {
  abandonSilentRun,
  createDb,
  insertEvent,
  listSilentLiveRuns,
} from "@offdesk/db";
import { sweepSilentRuns } from "@offdesk/usecase";
import type { WorkerEnv } from "../env.ts";

/*
  信号が途絶えた run を畳む（要件 `F-C6`・`F-I6`）。

  **`SessionEnd` の代わりではなく、その取りこぼしの受け皿。** hook が届けば
  `hooks/session-end.ts` が `done` で畳むので、ここまで来るのは
  **届かなかった run だけ** —— 実際 cloud session からは 1 度も届いていない。

  **Discord には出さない**（`sweep-queued-runs.ts` と同じ）。気づく手段は画面で、
  `events` の 1 行が run 詳細の時系列に並ぶ。
*/

export const sweepSilentLiveRuns = async (env: WorkerEnv): Promise<void> => {
  const db = createDb(env.DB);

  const { swept, raced } = await sweepSilentRuns({
    store: {
      listSilent: (before, limit) => listSilentLiveRuns(db, before, limit),
      abandon: (runKey, reason, before) =>
        abandonSilentRun(db, { runKey, reason, before }, Date.now()),
      record: async (runKey, body) => {
        await insertEvent(db, { runKey, kind: "error", body }, Date.now());
      },
    },
    nowMs: Date.now(),
  });

  // **`run_key` だけを出す**（脅威 12）。`prompt` はログに載せる理由が無い。
  if (swept.length > 0) {
    console.warn("[cron] 信号が途絶えた run を畳みました", {
      count: swept.length,
      runKeys: swept,
    });
  }

  /*
    **負けた分も出す。** 引いた直後に信号が届いた ＝ 窓の際で息をしている run が
    いる、という合図で、窓を見直す材料になる。
  */
  if (raced.length > 0) {
    console.warn("[cron] 畳む直前に信号が届いた run があります", {
      count: raced.length,
      runKeys: raced,
    });
  }
};
