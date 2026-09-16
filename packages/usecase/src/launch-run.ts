import type { RandomBytes, RunTarget } from "@offdesk/domain";
import {
  buildFireText,
  newRunKey,
  threadName,
  threadPrefix,
} from "@offdesk/domain";
import type {
  AnnouncerPort,
  RoutineLauncherPort,
  RunLedgerPort,
} from "./ports.ts";

export type LaunchRunDeps = {
  readonly ledger: RunLedgerPort;
  readonly announcer: AnnouncerPort;
  readonly launcher: RoutineLauncherPort;
  readonly randomBytes: RandomBytes;
};

export type LaunchRunInput = {
  readonly projectId: string;
  readonly projectName: string;
  /** **スレッドはいつもプロジェクトのチャンネルに立てる**（テーブル定義書 §4-3）。 */
  readonly channelId: string;
  readonly repoUrl: string;
  readonly fireUrl: string;
  readonly prompt: string;
  readonly requesterDiscordUserId: string;
  /** 何に対して働く run か（`/offdesk` の `issue` / `pr`）。 */
  readonly target: RunTarget;
};

/**
 * 起動が通らなかったときの姿。
 *
 * **`certain` を落とさない**（`FireOutcome` の why）。`false` は
 * 「起動したかどうか分からない」で、`failed` と同じ文言で伝えると嘘になる ——
 * 依頼者が「じゃあもう一度」と打った結果、**2 本が同じスレッドで動く。**
 */
export type LaunchFailure = {
  readonly reason: string;
  readonly certain: boolean;
};

export type LaunchRunOutcome = {
  readonly runKey: string;
  readonly threadId: string | null;
  readonly ccSessionUrl: string | null;
  /** **`null` は起動できた。** */
  readonly failure: LaunchFailure | null;
};

/**
 * 起動できなかったことを依頼者に伝える 1 行。
 *
 * **「起動しなかった」と「起動したか分からない」を同じ文言にしない。**
 * 前者は打ち直せばよいが、後者で打ち直すと 2 本が同じスレッドで動く
 * （スレッドの UNIQUE 索引は `queued` も生きているとみなすので、
 * 実際には 2 本目が作れずに詰まる）。**待たせる方が安い。**
 */
export const launchFailureText = (
  runKey: string,
  failure: LaunchFailure,
): string =>
  failure.certain
    ? `起動できませんでした（${runKey}）: ${failure.reason}`
    : `起動できたか確認できませんでした（${runKey}）: ${failure.reason}。\n` +
      "**セッションが動いている可能性があるので、すぐに打ち直さないでください。** " +
      "動いていれば数分のうちにこのスレッドへ何か出ます。何も出なければ 10 分ほどで自動的に畳まれるので、それから書き直してください。";

export const launchRun = async (
  deps: LaunchRunDeps,
  input: LaunchRunInput,
): Promise<LaunchRunOutcome> => {
  const runKey = newRunKey(deps.randomBytes);

  await deps.ledger.insert({
    runKey,
    projectId: input.projectId,
    prompt: input.prompt,
    requesterDiscordUserId: input.requesterDiscordUserId,
    channelId: input.channelId,
  });

  const announcement = {
    runKey,
    projectName: input.projectName,
    repoUrl: input.repoUrl,
    prompt: input.prompt,
    target: input.target,
  };

  const anchor = await deps.announcer.postAnchor(input.channelId, announcement);

  let threadId: string | null = null;
  if (anchor.ok) {
    const thread = await deps.announcer.openThread(
      input.channelId,
      anchor.id,
      threadName(threadPrefix(input.target), input.prompt),
    );
    if (thread.ok) {
      threadId = thread.id;
      await deps.ledger.attachThread(runKey, threadId);
    }
  }

  const fired = await deps.launcher.fire({
    projectId: input.projectId,
    fireUrl: input.fireUrl,
    /*
      **期待するリポジトリを毎回載せる**（`repoSection` の why）。
      どの routine がどこを clone するかは Anthropic 側の設定で読めないので、
      突き合わせはセッション自身にやらせるしかない。
    */
    text: buildFireText(runKey, input.prompt, input.target, input.repoUrl),
  });

  if (!fired.ok) {
    /*
      **言い切れるときだけ畳む。**

      `certain: false` は「POST の応答を受け取れなかった」であって「送っていない」
      ではない（`fire` に idempotency key は無いので、届いていればセッションは
      既に走っている）。そこで `failed` を書くと、そのセッションが最初に
      `ask_human` を呼んだ瞬間に `closed` が返って止まる。

      **`queued` のまま残す**のが正解 —— 動いていれば offdesk を呼んだ時点で
      run は先へ進み、動いていなければ 10 分後に cron が畳む
      （`sweepQueuedRuns`。hook の印が立っている run はそちらも触らない）。
    */
    if (fired.certain) await deps.ledger.markFailed(runKey, fired.reason);

    await deps.announcer.postText(
      threadId ?? input.channelId,
      launchFailureText(runKey, fired),
    );
    return {
      runKey,
      threadId,
      ccSessionUrl: null,
      failure: { reason: fired.reason, certain: fired.certain },
    };
  }

  await deps.ledger.markRunning(runKey, fired.session);

  if (threadId === null) {
    await deps.announcer.postText(
      input.channelId,
      `スレッドを作れませんでした。この run はスレッドに紐付いていません（${runKey}）。`,
    );
  }

  return {
    runKey,
    threadId,
    ccSessionUrl: fired.session?.ccSessionUrl ?? null,
    failure: null,
  };
};
