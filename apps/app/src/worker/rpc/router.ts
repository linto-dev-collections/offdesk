import { contract } from "@offdesk/contract";
import {
  checkFireToken,
  countRuns,
  createDb,
  encryptFireToken,
  findAnyProjectByChannel,
  findProjectByName,
  findProjectWithMaskById,
  findRunDetail,
  listAsks,
  listEvents,
  listInbox,
  listPendingAsks,
  listPlans,
  listProjectsWithMask,
  listRuns,
  listRunsByStatus,
  setProjectDisabled,
  updateProjectRow,
  upsertProjectWithCredential,
} from "@offdesk/db";
import { ROUTINE_PROMPT } from "@offdesk/domain";
import type {
  FireTokenBadReason,
  ProjectSummaryView,
  WriteProjectDeps,
  WriteProjectProblem,
} from "@offdesk/usecase";
import {
  createProject,
  DASHBOARD_ASK_LIMIT,
  DASHBOARD_FAILED_STATUSES,
  DASHBOARD_FAILURE_LIMIT,
  DASHBOARD_LIVE_LIMIT,
  DASHBOARD_LIVE_STATUSES,
  getDashboard,
  getRunDetail,
  listPlanSummaries,
  listProjectSummaries,
  listRunSummaries,
  setProjectDisabled as setProjectDisabledUseCase,
  updateProject,
} from "@offdesk/usecase";
import { implement, ORPCError } from "@orpc/server";
import { buildOffdeskCommand } from "../discord/commands.ts";
import { listGuildTextChannels, putCommands } from "../discord/rest.ts";
import { isConfigured, type WorkerEnv } from "../env.ts";
import { readGatewayStatus, resetGateway } from "../gateway/client.ts";
import { outboundFetch } from "../outbound.ts";
import { removePlan } from "../plans/routes.ts";
import { discordRestConfig } from "../session/launch.ts";
import type { RpcContext } from "./context.ts";

const os = implement(contract).$context<RpcContext>();

const authed = os.use(({ context, next }) => {
  if (context.session === null) throw new ORPCError("UNAUTHORIZED");
  return next({ context: { ...context, session: context.session } });
});

/**
 * **未設定なら `null`**（`DISCORD_GUILD_ID`）。スレッドのリンクが出なくなるだけで、
 * どの入口も止まらない（`ENDPOINT_GATED_ENV_NAMES` に並べてある理由）。
 */
const guildIdOf = (env: WorkerEnv): string | null => {
  const raw = env.DISCORD_GUILD_ID?.trim() ?? "";
  return raw === "" ? null : raw;
};

/**
 * 書き込みに要る口を 1 か所で束ねる。**ここだけが D1 と暗号化と Anthropic を
 * 同時に知っている**（要件 §10-3 ルール 3）。ユースケースは 3 つとも知らない。
 */
const writeProjectDeps = (env: WorkerEnv): WriteProjectDeps => {
  const db = createDb(env.DB);
  const key = env.FIRE_TOKEN_KEY;

  return {
    guildId: guildIdOf(env),
    cipher: { encrypt: (plaintext) => encryptFireToken(key, plaintext) },
    verifier: {
      verify: (input) => checkFireToken({ fetch: outboundFetch }, input),
    },
    store: {
      findByName: (name) => findProjectByName(db, name),
      findByChannel: (channelId) => findAnyProjectByChannel(db, channelId),
      findWithMask: (id) => findProjectWithMaskById(db, id),
      upsert: (input, encrypted) =>
        upsertProjectWithCredential(db, input, encrypted),
      update: (input, encrypted) => updateProjectRow(db, input, encrypted),
      setDisabled: (id, disabled) =>
        setProjectDisabled(db, id, disabled, Date.now()),
    },
  };
};

/**
 * 台帳を書く 3 本が受け取るエラーの作り手（契約の `PROJECT_WRITE_ERRORS` と対）。
 *
 * **oRPC の型をそのまま書かない。** あちらは `MergedErrorMap<…>` で読めた形に
 * ならないので、**使う 4 つだけを構造で要求する** —— 契約から 1 つ落ちれば
 * ここで型が合わなくなる。
 */
type ProjectWriteErrors = {
  readonly NOT_FOUND: () => Error;
  readonly SERVICE_UNAVAILABLE: () => Error;
  readonly CONFLICT: (payload: {
    data: { field: "name" | "discordChannelId" };
  }) => Error;
  readonly UNPROCESSABLE_CONTENT: (payload: {
    data: { kind: FireTokenBadReason };
  }) => Error;
};

/**
 * **鍵が無ければ書かせない**（要件 `F-H2`）。
 *
 * `FIRE_TOKEN_KEY` は `ENDPOINT_GATED_ENV_NAMES` に居るので、欠けてもデプロイは
 * 通る —— 欠けたまま書かせると**暗号化に失敗した行が残る**ので、入口で止める。
 */
const assertCipherable = (env: WorkerEnv, errors: ProjectWriteErrors): void => {
  if (!isConfigured(env.FIRE_TOKEN_KEY)) throw errors.SERVICE_UNAVAILABLE();
};

/** ユースケースの失敗を、口の側の状態コードへ写す（HTTP を知るのはここだけ）。 */
const writeProblem = (
  problem: WriteProjectProblem,
  errors: ProjectWriteErrors,
): Error => {
  if (problem.kind === "not_found") return errors.NOT_FOUND();
  if (problem.kind === "conflict") {
    return errors.CONFLICT({ data: { field: problem.field } });
  }
  return errors.UNPROCESSABLE_CONTENT({ data: { kind: problem.reason } });
};

type CommandsOutcome =
  | {
      readonly kind: "ok";
      readonly registered: readonly string[];
      readonly scope: string;
    }
  | { readonly kind: "failed" }
  | { readonly kind: "unconfigured" };

/** `/offdesk` の選択肢を、いま有効なプロジェクトで登録し直す。 */
const registerCommands = async (env: WorkerEnv): Promise<CommandsOutcome> => {
  for (const name of ["DISCORD_BOT_TOKEN", "DISCORD_APPLICATION_ID"] as const) {
    if (!isConfigured(env[name])) return { kind: "unconfigured" };
  }

  const names = (await listProjectsWithMask(createDb(env.DB)))
    .filter((row) => row.disabledAt === null)
    .map((row) => row.name);

  const guildId = guildIdOf(env);
  const result = await putCommands(
    discordRestConfig(env),
    [buildOffdeskCommand(names)],
    guildId ?? undefined,
  );

  return result.ok
    ? { kind: "ok", registered: names, scope: guildId ?? "global" }
    : { kind: "failed" };
};

/**
 * 台帳を変えた直後に `/offdesk` を登録し直し、**できたかどうかを応答に載せる。**
 *
 * **失敗しても書き込みは成功扱いにする。** 台帳は正しく、足りないのは登録し直し
 * だけ —— ここでエラーにすると「保存できませんでした」と出るのに台帳には入って
 * いる、という最悪の食い違いになる。画面はボタンでやり直せる。
 *
 * **これが OPERATIONS §2 のいちばん静かな取りこぼしを潰す。** 選択肢は登録の
 * 時点で焼き込まれるので、台帳に入れただけでは Discord に新しい名前が出ない
 * （**画面には出るので気づきにくい**）。
 */
const withCommands = async (
  env: WorkerEnv,
  project: ProjectSummaryView,
): Promise<{ project: ProjectSummaryView; commandsRegistered: boolean }> => {
  const outcome = await registerCommands(env);
  if (outcome.kind !== "ok") {
    console.warn("[projects] /offdesk を登録し直せませんでした", {
      reason: outcome.kind,
    });
  }

  return { project, commandsRegistered: outcome.kind === "ok" };
};

export const router = os.router({
  me: authed.me.handler(({ context }) => ({
    email: context.session.user.email,
    name: context.session.user.name,
    imageUrl: context.session.user.image ?? null,
  })),
  dashboard: {
    summary: authed.dashboard.summary.handler(async ({ context }) => {
      const db = createDb(context.env.DB);

      /*
        **件数と状態のまとまりを渡すのはここ。** `packages/usecase` の定数を
        `packages/db` のクエリに繋ぐのがアダプタの仕事で、ユースケース側は
        「引いた行を DTO に畳む」だけを持つ。
      */
      const view = await getDashboard({
        store: {
          liveRuns: () =>
            listRunsByStatus(db, DASHBOARD_LIVE_STATUSES, DASHBOARD_LIVE_LIMIT),
          pendingAsks: () => listPendingAsks(db, DASHBOARD_ASK_LIMIT),
          recentFailures: () =>
            listRunsByStatus(
              db,
              DASHBOARD_FAILED_STATUSES,
              DASHBOARD_FAILURE_LIMIT,
            ),
        },
        guildId: guildIdOf(context.env),
      });

      return {
        liveRuns: [...view.liveRuns],
        pendingAsks: [...view.pendingAsks],
        recentFailures: [...view.recentFailures],
      };
    }),
  },
  gateway: {
    status: authed.gateway.status.handler(
      async ({ context }) => (await readGatewayStatus(context.env)).body,
    ),
    /*
      **サーバー側でも間隔を検査する**（脅威 15）。判定そのものは DO が持つ
      （evict を挟んでもすり抜けないよう時刻を永続させてある）ので、
      ここは 429 を oRPC のエラーへ translate するだけ ——
      **画面の判定を信じる形にはしない。**
    */
    reset: authed.gateway.reset.handler(async ({ context, errors }) => {
      const reply = await resetGateway(context.env);

      if (reply.status === 429) {
        throw errors.TOO_MANY_REQUESTS({ data: reply.body });
      }

      return reply.body;
    }),
  },
  plans: {
    list: authed.plans.list.handler(async ({ context }) => {
      const db = createDb(context.env.DB);

      const items = await listPlanSummaries({
        store: { list: (limit) => listPlans(db, limit) },
        guildId: guildIdOf(context.env),
      });

      return { items: [...items] };
    }),
    /*
      **`removed: false` はエラーにしない**（`PlanRemoveOutput` の why）。
      一覧が古いだけなので、画面は引き直せばよい。
    */
    remove: authed.plans.remove.handler(async ({ context, input }) => ({
      removed: await removePlan(context.env, input.planId),
    })),
  },
  projects: {
    list: authed.projects.list.handler(async ({ context }) => {
      const db = createDb(context.env.DB);
      const items = await listProjectSummaries({
        store: { listWithMask: () => listProjectsWithMask(db) },
        guildId: guildIdOf(context.env),
      });
      return { items: [...items] };
    }),

    create: authed.projects.create.handler(
      async ({ context, input, errors }) => {
        assertCipherable(context.env, errors);

        const result = await createProject(
          writeProjectDeps(context.env),
          input,
        );
        if (!result.ok) throw writeProblem(result.problem, errors);

        return await withCommands(context.env, result.project);
      },
    ),

    update: authed.projects.update.handler(
      async ({ context, input, errors }) => {
        assertCipherable(context.env, errors);

        const result = await updateProject(
          writeProjectDeps(context.env),
          input,
        );
        if (!result.ok) throw writeProblem(result.problem, errors);

        /*
          **直しても `/offdesk` を登録し直す。** 名前は変わらないので選択肢は
          同じはずだが、**ずれていたときにここで戻る**のが安い（登録は冪等）。
        */
        return await withCommands(context.env, result.project);
      },
    ),

    setDisabled: authed.projects.setDisabled.handler(
      async ({ context, input, errors }) => {
        const result = await setProjectDisabledUseCase(
          writeProjectDeps(context.env),
          input,
        );
        if (!result.ok) throw writeProblem(result.problem, errors);

        /*
          **ここは登録し直しが本体。** 無効にしても `/offdesk` の選択肢からは
          自動で消えない（選択肢は登録の時点で焼き込まれる）—— OPERATIONS §2 が
          「そのあと `commands` を回す」と書いていた手順がこれで消える。
        */
        return await withCommands(context.env, result.project);
      },
    ),

    syncCommands: authed.projects.syncCommands.handler(
      async ({ context, errors }) => {
        const outcome = await registerCommands(context.env);

        if (outcome.kind === "unconfigured") {
          throw errors.SERVICE_UNAVAILABLE();
        }
        if (outcome.kind === "failed") throw errors.BAD_GATEWAY();

        return { registered: [...outcome.registered], scope: outcome.scope };
      },
    ),

    channels: authed.projects.channels.handler(async ({ context }) => {
      const guildId = guildIdOf(context.env);
      if (guildId === null || !isConfigured(context.env.DISCORD_BOT_TOKEN)) {
        return { available: false, items: [] };
      }

      const channels = await listGuildTextChannels(
        discordRestConfig(context.env),
        guildId,
      );
      if (channels === null) return { available: false, items: [] };

      /*
        **既に使われているチャンネルに印を付ける**（要件 `F-H4`）。
        止めたプロジェクトが握っているものも「使用中」—— `projects_channel_uidx` は
        `disabled_at` を見ないので、選ばせると保存の瞬間に落ちる。
      */
      const taken = new Set(
        (await listProjectsWithMask(createDb(context.env.DB))).map(
          (row) => row.discordChannelId,
        ),
      );

      return {
        available: true,
        items: channels.map((channel) => ({
          ...channel,
          taken: taken.has(channel.id),
        })),
      };
    }),

    /*
      **画面から配る**（`pnpm routine:prompt` を畳んだ先）。

      正本は `packages/domain` の `ROUTINE_PROMPT` で、ここは運ぶだけ ——
      クライアントに焼き込むと**デプロイしていない版の文面を配る**ことになる
      （プロンプトは routine に焼き込まれるので、ズレても静かに動き続ける）。
    */
    routinePrompt: authed.projects.routinePrompt.handler(() => ({
      prompt: ROUTINE_PROMPT,
    })),
  },
  runs: {
    list: authed.runs.list.handler(async ({ context, input }) => {
      const db = createDb(context.env.DB);

      const view = await listRunSummaries(
        {
          store: {
            list: (page) => listRuns(db, page),
            count: (filter) => countRuns(db, filter),
          },
          guildId: guildIdOf(context.env),
          nowMs: Date.now(),
        },
        input,
      );

      return { ...view, items: [...view.items] };
    }),
    detail: authed.runs.detail.handler(async ({ context, input }) => {
      const db = createDb(context.env.DB);

      const view = await getRunDetail(
        {
          store: {
            find: (runKey) => findRunDetail(db, runKey),
            asks: (runKey) => listAsks(db, runKey),
            events: (runKey) => listEvents(db, runKey),
            inbox: (runKey) => listInbox(db, runKey),
          },
          guildId: guildIdOf(context.env),
        },
        input.runKey,
      );

      /*
        **見つからないことを 404 で返す。** 出力の型に「無い」を入れると
        画面側が毎回 null を捌くことになり、**「まだ読み込み中」と
        「その run は無い」の区別**が呼び出し側から消える。
      */
      if (view === null) throw new ORPCError("NOT_FOUND");

      /*
        **`readonly` を外すのはこの層。** ユースケースの返り値は全部
        `readonly` で、契約の Zod が導く型は素の配列 —— 境界で 1 回だけ
        写す（`packages/usecase` を可変にすると、他の呼び出し側で
        書き換えられる余地が残る）。
      */
      return {
        ...view,
        timeline: view.timeline.map((entry) =>
          entry.kind === "ask"
            ? { ...entry, options: [...entry.options] }
            : entry,
        ),
      };
    }),
  },
});
