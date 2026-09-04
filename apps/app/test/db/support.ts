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
