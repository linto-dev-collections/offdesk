import { contract } from "@offdesk/contract";
import {
  countRuns,
  createDb,
  findRunDetail,
  listAsks,
  listEvents,
  listInbox,
  listPendingAsks,
  listProjectsWithMask,
  listRuns,
  listRunsByStatus,
} from "@offdesk/db";
import {
  DASHBOARD_ASK_LIMIT,
  DASHBOARD_FAILED_STATUSES,
  DASHBOARD_FAILURE_LIMIT,
  DASHBOARD_LIVE_LIMIT,
  DASHBOARD_LIVE_STATUSES,
  getDashboard,
  getRunDetail,
  listProjectSummaries,
  listRunSummaries,
} from "@offdesk/usecase";
import { implement, ORPCError } from "@orpc/server";
import type { WorkerEnv } from "../env.ts";
import { removePlan } from "../plans/routes.ts";
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
  plans: {
    remove: authed.plans.remove.handler(async ({ context, input }) => ({
      removed: await removePlan(context.env, input.planId),
    })),
  },
  projects: {
    list: authed.projects.list.handler(async ({ context }) => {
      const db = createDb(context.env.DB);
      const items = await listProjectSummaries({
        listWithMask: () => listProjectsWithMask(db),
      });
      return { items: [...items] };
    }),
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
