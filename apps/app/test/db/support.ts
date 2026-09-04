import { env } from "cloudflare:workers";
import {
  createDb,
  encryptFireToken,
  upsertProjectWithCredential,
} from "@offdesk/db";

export const FIRE_URL =
  "https://api.anthropic.com/v1/claude_code/routines/trig_test/fire";

export const CHANNEL_ALPHA = "111111111111111111";
export const CHANNEL_BETA = "222222222222222222";

export const db = () => createDb(env.DB);

/*
  **プロジェクトは 2 つ以上入れる**（要件 `N-9`）。1 つだと「唯一だから選ばれた」に
  守られて、チャンネルとの紐付けが壊れていても気付けない。
*/
export const seedProject = async (input: {
  readonly name: string;
  readonly discordChannelId: string;
  readonly fireToken?: string;
  readonly fireUrl?: string;
  readonly repoUrl?: string;
}): Promise<string> => {
  const encrypted = await encryptFireToken(
    env.FIRE_TOKEN_KEY,
    input.fireToken ?? "sk-ant-oat01-test-token-aB3x",
  );

  const { projectId } = await upsertProjectWithCredential(
    db(),
    {
      name: input.name,
      discordChannelId: input.discordChannelId,
      repoUrl:
        input.repoUrl ??
        "https://github.com/linto-dev-collections/offdesk-test",
      fireUrl: input.fireUrl ?? FIRE_URL,
    },
    encrypted,
  );

  return projectId;
};

export const seedTwoProjects = async (): Promise<{
  readonly alpha: string;
  readonly beta: string;
}> => ({
  alpha: await seedProject({
    name: "offdesk-test",
    discordChannelId: CHANNEL_ALPHA,
  }),
  beta: await seedProject({ name: "dummy", discordChannelId: CHANNEL_BETA }),
});

export const runRows = async (): Promise<
  readonly {
    run_key: string;
    status: string;
    thread_id: string | null;
    cc_session_id: string | null;
    cc_session_url: string | null;
    finished_at: number | null;
    failure_reason: string | null;
    channel_id: string;
  }[]
> => {
  const { results } = await env.DB.prepare(
    "SELECT run_key, status, thread_id, cc_session_id, cc_session_url, finished_at, failure_reason, channel_id FROM runs ORDER BY created_at",
  ).all();
  return results as never;
};

/*
  P3a（握り）が使う種。**run を 1 本立てて `running` にする**——
  `queued` のままでも握れるが、実物では fire が通った後に握られるので、
  そちらに合わせておく。
*/

export const RUN_KEY = "OFFDESK-1111111111111111";
export const THREAD_ID = "444444444444444444";

export const seedRun = async (input: {
  readonly runKey?: string;
  readonly projectId: string;
  readonly channelId?: string;
  readonly threadId?: string | null;
  readonly status?: string;
  readonly finishedAt?: number | null;
  readonly heldAt?: number | null;
}): Promise<string> => {
  const runKey = input.runKey ?? RUN_KEY;
  const status = input.status ?? "running";
  /*
    **`runs_finished_ck` は「終端 ⇔ finished_at が非 NULL」を要求する。**
    種を作る側でここを外すと、テストが「制約違反」で落ちて本題が見えなくなる。
  */
  const terminal = ["done", "failed", "abandoned"].includes(status);
  const finishedAt = terminal ? (input.finishedAt ?? Date.now()) : null;

  await env.DB.prepare(
    `INSERT INTO runs (run_key, project_id, prompt, status, requester_discord_user_id,
                       channel_id, thread_id, held_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      runKey,
      input.projectId,
      "ping",
      status,
      "111111111111111111",
      input.channelId ?? CHANNEL_ALPHA,
      input.threadId === undefined ? THREAD_ID : input.threadId,
      input.heldAt ?? null,
      finishedAt,
    )
    .run();

  return runKey;
};

export const askRows = async (): Promise<
  readonly {
    ask_id: string;
    run_key: string;
    question: string;
    options: string;
    allow_free_text: number;
    message_id: string | null;
    answer: string | null;
    answered_by_discord_user_id: string | null;
    answered_at: number | null;
    answer_message_id: string | null;
    delivered_at: number | null;
  }[]
> => {
  const { results } = await env.DB.prepare(
    `SELECT ask_id, run_key, question, options, allow_free_text, message_id, answer,
            answered_by_discord_user_id, answered_at, answer_message_id, delivered_at
     FROM asks ORDER BY created_at, ask_id`,
  ).all();
  return results as never;
};

export const runHeldAt = async (runKey: string): Promise<number | null> => {
  const row = await env.DB.prepare("SELECT held_at FROM runs WHERE run_key = ?")
    .bind(runKey)
    .first<{ held_at: number | null }>();
  return row?.held_at ?? null;
};

export const runStatus = async (runKey: string): Promise<string | null> => {
  const row = await env.DB.prepare("SELECT status FROM runs WHERE run_key = ?")
    .bind(runKey)
    .first<{ status: string }>();
  return row?.status ?? null;
};

/* P4（素の文）が使う。 */

export const inboxRows = async (): Promise<
  readonly {
    id: number;
    run_key: string;
    author_discord_user_id: string;
    message_id: string | null;
    body: string;
    taken_at: number | null;
    taken_by_run_key: string | null;
  }[]
> => {
  const { results } = await env.DB.prepare(
    `SELECT id, run_key, author_discord_user_id, message_id, body, taken_at, taken_by_run_key
     FROM inbox ORDER BY id`,
  ).all();
  return results as never;
};

export const runActivityAt = async (runKey: string): Promise<number | null> => {
  const row = await env.DB.prepare(
    "SELECT activity_at FROM runs WHERE run_key = ?",
  )
    .bind(runKey)
    .first<{ activity_at: number | null }>();
  return row?.activity_at ?? null;
};
