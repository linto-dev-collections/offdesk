/**
 * 信号が途絶えた run を畳むまでの窓。
 *
 * **2 時間の根拠は実測。** 生きているセッションの沈黙は最長 77 分だった ——
 * hook は道具を呼ぶたびに鳴るので、働いているセッションが 2 時間黙ることはない。
 * 誤って畳むと `ask_human` が `closed` を返してセッションが止まるので、
 * 実測の 1.5 倍以上を取ってある。
 *
 * **`INBOUND_ACTIVE_WINDOW_MS`（6 時間）とは別の数字。** あちらは素の文を溜めるか
 * 起こし直すかの窓だが、掃除が畳んだ run は終端になり `decideInbound` は
 * 終端を先に見るので、**実質の判定はこちらが決める。** あちらは cron が
 * 止まったときの保険として長いまま残す。
 */
export const SILENT_SWEEP_AFTER_MS = 2 * 60 * 60_000;

/** 1 回で畳む上限（`QUEUED_SWEEP_LIMIT` と同じ理由 —— cron の 1 回を短く保つ）。 */
export const SILENT_SWEEP_LIMIT = 50;

/**
 * `events` に残す 1 行（要件 `N-7`）。**時間は定数から出す**（文だけ古くならない）。
 *
 * **`failure_reason` には書けない**（`runs_failure_reason_ck` は `failed` と
 * `abandoned` にしか許さない）。掃除で畳んだことを持つのはこの 1 行だけ。
 */
export const SILENT_SWEEP_EVENT_BODY =
  `セッションからの信号が ${SILENT_SWEEP_AFTER_MS / 3_600_000} 時間以上途絶えたので、この run を終了として畳みました。` +
  "同じスレッドに書き直せば新しい run が立ちます。";

export type SweepSilentRunsPort = {
  readonly listSilent: (
    before: number,
    limit: number,
  ) => Promise<readonly { readonly runKey: string }[]>;
  readonly finish: (runKey: string, before: number) => Promise<boolean>;
  readonly record: (runKey: string, body: string) => Promise<void>;
};

export type SweepSilentRunsDeps = {
  readonly store: SweepSilentRunsPort;
  readonly nowMs: number;
};

export type SweepSilentRunsResult = {
  readonly swept: readonly string[];
  readonly raced: readonly string[];
};

export const sweepSilentRuns = async (
  deps: SweepSilentRunsDeps,
): Promise<SweepSilentRunsResult> => {
  /*
    **同じ `before` を引くときと畳むときの両方に渡す。** 畳む側の UPDATE がこの境目を
    条件に持つので、引いてから畳むまでに信号が届いた run は自動的に外れる。
  */
  const before = deps.nowMs - SILENT_SWEEP_AFTER_MS;
  const silent = await deps.store.listSilent(before, SILENT_SWEEP_LIMIT);

  const swept: string[] = [];
  const raced: string[] = [];

  for (const run of silent) {
    if (!(await deps.store.finish(run.runKey, before))) {
      raced.push(run.runKey);
      continue;
    }

    await deps.store.record(run.runKey, SILENT_SWEEP_EVENT_BODY);
    swept.push(run.runKey);
  }

  return { swept, raced };
};
