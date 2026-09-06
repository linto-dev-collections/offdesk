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

export type LaunchRunOutcome = {
  readonly runKey: string;
  readonly threadId: string | null;
  readonly ccSessionUrl: string | null;
  readonly failureReason: string | null;
};

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
    text: buildFireText(runKey, input.prompt, input.target),
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
