/**
 * 起動が完了しなかった run を畳む（要件 `F-I6`・計画 P8 §3-2）。
 *
 * ## なぜ 10 分か
 *
 * `/offdesk` の続き（スレッド作成 → routine 起動）は `waitUntil` の中で走るが、
 * そこは**応答から 30 秒**で切られる。途中で切れると台帳に `queued` の行だけが
 * 残り、`decideInbound` からは「作業中」に見えるので、**以後そのスレッドの発言が
 * 全部そこへ吸い込まれて誰も読まない**（書いたのに何も起きない）。
 * 30 秒より十分長く、人の待ち時間として許せる長さがこれ。
 *
 * ## 起こし直さない
 *
 * 畳むだけで、新しい run は立てない。**実は起動できていた場合に 2 本目が立つ**
 * ——畳んでおけば、次の 1 行が `restart` として拾う（P4 の `decideInbound`）。
 */
export const QUEUED_SWEEP_AFTER_MS = 10 * 60_000;

/**
 * 1 回で畳む上限。
 *
 * **上限を持つのは cron の 1 回を短く保つため。** 5 分ごとに走るので、
 * 溢れた分は次の回で畳まれる —— 上限が無いと、何かの事故で `queued` が
 * 大量に残ったときに 1 回の cron が D1 の書き込みで詰まる。
 */
export const QUEUED_SWEEP_LIMIT = 50;

/**
 * `runs.failure_reason` に入る文。**run 詳細にそのまま出る。**
 *
 * **URL もトークンも載せない**（脅威 12）。載せる余地が無いよう定数にしてある。
 */
export const QUEUED_SWEEP_REASON = "起動が完了しなかった";

/** `events` に残す 1 行（要件 `N-7`「無言で捨てない」）。 */
export const QUEUED_SWEEP_EVENT_BODY =
  "起動が完了しないまま 10 分が過ぎたので、この run を失敗として畳みました。" +
  "同じスレッドに書き直せば新しい run が立ちます。";

export type SweepQueuedRunsPort = {
  readonly listStale: (
    before: number,
    limit: number,
  ) => Promise<readonly { readonly runKey: string }[]>;
  /** `false` は「負けた」＝ その run は既に動き出していた。 */
  readonly fail: (runKey: string, reason: string) => Promise<boolean>;
  readonly record: (runKey: string, body: string) => Promise<void>;
};

export type SweepQueuedRunsDeps = {
  readonly store: SweepQueuedRunsPort;
  readonly nowMs: number;
};

export type SweepQueuedRunsResult = {
  /** 畳めた run。 */
  readonly swept: readonly string[];
  /** 引いた後に動き出していた run（畳まなかった）。 */
  readonly raced: readonly string[];
};

export const sweepQueuedRuns = async (
  deps: SweepQueuedRunsDeps,
): Promise<SweepQueuedRunsResult> => {
  const stale = await deps.store.listStale(
    deps.nowMs - QUEUED_SWEEP_AFTER_MS,
    QUEUED_SWEEP_LIMIT,
  );

  const swept: string[] = [];
  const raced: string[] = [];

  /*
    **1 本ずつ順に畳む。** `Promise.all` で並べると D1 への書き込みが同時に
    走るが、この掃除は 5 分に 1 回の遅れて構わない仕事で、**急ぐ理由が無い**
    —— 直列なら 1 本が落ちても残りが走る（下の `catch` が効く）。
  */
  for (const run of stale) {
    /*
      **記録は畳めたときだけ。** 負けた run（既に `running`）に
      `error` の行を足すと、正常に動いている run の詳細に嘘が並ぶ。
    */
    if (!(await deps.store.fail(run.runKey, QUEUED_SWEEP_REASON))) {
      raced.push(run.runKey);
      continue;
    }

    await deps.store.record(run.runKey, QUEUED_SWEEP_EVENT_BODY);
    swept.push(run.runKey);
  }

  return { swept, raced };
};
