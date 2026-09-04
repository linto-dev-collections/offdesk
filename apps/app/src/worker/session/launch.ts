import {
  attachRunThread,
  createDb,
  fireRoutine,
  insertRun,
  markRunFailed,
  markRunRunning,
  takeFireToken,
} from "@offdesk/db";
import type {
  AnnouncerPort,
  LaunchRunInput,
  LaunchRunOutcome,
  RoutineLauncherPort,
  RunLedgerPort,
} from "@offdesk/usecase";
import { launchRun } from "@offdesk/usecase";
import { noticeMessage, startedMessage } from "../discord/components.ts";
import type { DiscordRestConfig } from "../discord/rest.ts";
import { createThreadFromMessage, postMessage } from "../discord/rest.ts";
import type { WorkerEnv } from "../env.ts";
import { outboundFetch } from "../outbound.ts";

export const discordRestConfig = (env: WorkerEnv): DiscordRestConfig => ({
  botToken: env.DISCORD_BOT_TOKEN,
  applicationId: env.DISCORD_APPLICATION_ID,
  fetch: outboundFetch,
});

/**
 * ポートに実物を差す（要件 §10-3 ルール 3）。**ここだけが D1 と Discord と
 * Anthropic を同時に知っている。** ユースケースは 3 つとも知らない。
 */
export const launchRunWithEnv = async (
  env: WorkerEnv,
  input: LaunchRunInput,
): Promise<LaunchRunOutcome> => {
  const db = createDb(env.DB);
  const rest = discordRestConfig(env);

  const ledger: RunLedgerPort = {
    insert: (values) => insertRun(db, values, Date.now()),
    attachThread: (runKey, threadId) => attachRunThread(db, runKey, threadId),
    markRunning: (runKey, session) => markRunRunning(db, runKey, session),
    markFailed: (runKey, reason) =>
      markRunFailed(db, runKey, reason, Date.now()),
  };

  const announcer: AnnouncerPort = {
    postAnchor: (channelId, announcement) =>
      postMessage(rest, channelId, startedMessage(announcement)),
    openThread: (channelId, messageId, name) =>
      createThreadFromMessage(rest, channelId, messageId, name),
    postText: (channelId, text) =>
      postMessage(rest, channelId, noticeMessage(text)),
  };

  const launcher: RoutineLauncherPort = {
    fire: (values) =>
      fireRoutine(
        {
          fetch: outboundFetch,
          takeFireToken: (projectId) =>
            takeFireToken(db, env.FIRE_TOKEN_KEY, projectId),
        },
        values,
      ),
  };

  return await launchRun(
    {
      ledger,
      announcer,
      launcher,
      randomBytes: (byteLength) =>
        crypto.getRandomValues(new Uint8Array(byteLength)),
    },
    input,
  );
};
