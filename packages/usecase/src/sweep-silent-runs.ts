import { INBOUND_ACTIVE_WINDOW_MS } from "@offdesk/domain";

export const SILENT_SWEEP_AFTER_MS = INBOUND_ACTIVE_WINDOW_MS;

/** 1 回で畳む上限（`QUEUED_SWEEP_LIMIT` と同じ理由 —— cron の 1 回を短く保つ）。 */
export const SILENT_SWEEP_LIMIT = 50;

/** `runs.failure_reason` に入る文。**URL もトークンも載せない**（脅威 12）。 */
export const SILENT_SWEEP_REASON = "セッションからの信号が途絶えた";

/** `events` に残す 1 行（要件 `N-7`）。**時間は定数から出す**（文だけ古くならない）。 */
export const SILENT_SWEEP_EVENT_BODY =
  `セッションからの信号が ${SILENT_SWEEP_AFTER_MS / 3_600_000} 時間以上途絶えたので、この run を破棄として畳みました。` +
  "同じスレッドに書き直せば新しい run が立ちます。";

export type SweepSilentRunsPort = {
  readonly listSilent: (
    before: number,
    limit: number,
  ) => Promise<readonly { readonly runKey: string }[]>;
  readonly abandon: (
    runKey: string,
    reason: string,
    before: number,
  ) => Promise<boolean>;
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
    条件に持つので、引いてから畳むまでに信号が届いた run は自動的に外れる ——
    生きているセッションを終端にすると、その `ask_human` が `closed` を受け取って
    作業をやめる（**動いている run を殺すことになる**）。
  */
  const before = deps.nowMs - SILENT_SWEEP_AFTER_MS;
  const silent = await deps.store.listSilent(before, SILENT_SWEEP_LIMIT);

  const swept: string[] = [];
  const raced: string[] = [];

  for (const run of silent) {
    if (!(await deps.store.abandon(run.runKey, SILENT_SWEEP_REASON, before))) {
      raced.push(run.runKey);
      continue;
    }

    await deps.store.record(run.runKey, SILENT_SWEEP_EVENT_BODY);
    swept.push(run.runKey);
  }

  return { swept, raced };
};
