import type { RandomBytes } from "@offdesk/domain";
import { buildFireText, newRunKey, threadName } from "@offdesk/domain";
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
};

export type LaunchRunOutcome = {
  readonly runKey: string;
  readonly threadId: string | null;
  readonly ccSessionUrl: string | null;
  readonly failureReason: string | null;
};

const THREAD_PREFIX = "OFFDESK";

/**
 * run を 1 本起こす（計画 P2 §3-9）。
 *
 * **台帳の行を先に作る。** スレッド作成も routine の起動も失敗しうるが、行が先にあれば
 * 「何を試みて失敗したか」が後から引ける。
 *
 * **スレッドを作れなかったら `thread_id` は NULL のまま**（要件 `F-A7`・`I-4`）。
 * チャンネル id を入れると、そのチャンネルの雑談が丸ごと Claude への入力になる。
 *
 * **起動に失敗しても勝手に起こし直さない**（要件 `F-A6`）。実は起動できていた場合に
 * 2 本目が立つ。`failed` に畳んで人に見せる。
 */
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
  };

  const anchor = await deps.announcer.postAnchor(input.channelId, announcement);

  let threadId: string | null = null;
  if (anchor.ok) {
    const thread = await deps.announcer.openThread(
      input.channelId,
      anchor.id,
      threadName(THREAD_PREFIX, input.prompt),
    );
    if (thread.ok) {
      threadId = thread.id;
      await deps.ledger.attachThread(runKey, threadId);
    }
  }

  const fired = await deps.launcher.fire({
    projectId: input.projectId,
    fireUrl: input.fireUrl,
    text: buildFireText(runKey, input.prompt),
  });

  if (!fired.ok) {
    await deps.ledger.markFailed(runKey, fired.reason);
    await deps.announcer.postText(
      threadId ?? input.channelId,
      `起動できませんでした（${runKey}）: ${fired.reason}`,
    );
    return {
      runKey,
      threadId,
      ccSessionUrl: null,
      failureReason: fired.reason,
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
    failureReason: null,
  };
};
