import {
  contextWindowFor,
  discordThreadUrl,
  hasKnownContextWindow,
  truncate,
} from "@offdesk/domain";

export type RunStatusView =
  | "queued"
  | "running"
  | "waiting"
  | "done"
  | "failed"
  | "abandoned";

export const RUN_PAGE_SIZE = 50;

export const RUN_PROMPT_PREVIEW_LENGTH = 120;

const DAY_MS = 24 * 60 * 60 * 1000;

export type RunRow = {
  readonly runKey: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly status: RunStatusView;
  readonly prompt: string;
  readonly threadId: string | null;
  readonly ctxUsedTokens: number | null;
  readonly ctxModel: string | null;
  readonly createdAt: number;
  readonly finishedAt: number | null;
};

export type RunSummaryView = {
  readonly runKey: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly status: RunStatusView;
  readonly prompt: string;
  readonly promptTruncated: boolean;
  readonly threadUrl: string | null;
  readonly createdAt: number;
  readonly finishedAt: number | null;
  readonly contextPercent: number | null;
  readonly contextUsedTokens: number | null;
  readonly contextWindowTokens: number;
  readonly contextWindowKnown: boolean;
};

export type RunListFilterInput = {
  readonly projectId?: string | undefined;
  readonly status?: RunStatusView | undefined;
  readonly since: number;
};

export type RunStorePort = {
  readonly list: (
    page: RunListFilterInput & {
      readonly limit: number;
      readonly offset: number;
      readonly sort: "createdAt" | "updatedAt";
      readonly order: "asc" | "desc";
    },
  ) => Promise<readonly RunRow[]>;
  readonly count: (filter: RunListFilterInput) => Promise<number>;
};

export const contextPercentOf = (input: {
  readonly usedTokens: number | null;
  readonly model: string | null;
}): number | null => {
  if (input.usedTokens === null) return null;
  if (!hasKnownContextWindow(input.model)) return null;

  const window = contextWindowFor(input.model);
  if (window <= 0) return null;

  return Math.round((Math.max(input.usedTokens, 0) / window) * 100);
};

export const toRunSummary = (
  row: RunRow,
  guildId: string | null,
): RunSummaryView => {
  const flat = row.prompt.replace(/\s+/g, " ").trim();

  return {
    runKey: row.runKey,
    projectId: row.projectId,
    projectName: row.projectName,
    status: row.status,
    prompt: truncate(flat, RUN_PROMPT_PREVIEW_LENGTH),
    promptTruncated: flat.length > RUN_PROMPT_PREVIEW_LENGTH,
    threadUrl: discordThreadUrl({ guildId, threadId: row.threadId }),
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
    contextPercent: contextPercentOf({
      usedTokens: row.ctxUsedTokens,
      model: row.ctxModel,
    }),
    // `%` がどこから出たかも返す（`get-run-detail.ts` と同じ 3 つ）。
    contextUsedTokens: row.ctxUsedTokens,
    contextWindowTokens: contextWindowFor(row.ctxModel),
    contextWindowKnown: hasKnownContextWindow(row.ctxModel),
  };
};

export type ListRunsInput = {
  readonly projectId?: string | undefined;
  readonly status?: RunStatusView | undefined;
  readonly sinceDays: number;
  readonly page: number;
  readonly sort: "createdAt" | "updatedAt";
  readonly order: "asc" | "desc";
};

export type ListRunsDeps = {
  readonly store: RunStorePort;
  readonly guildId: string | null;
  readonly nowMs: number;
};

export type RunListView = {
  readonly items: readonly RunSummaryView[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
};

export const listRunSummaries = async (
  deps: ListRunsDeps,
  input: ListRunsInput,
): Promise<RunListView> => {
  const filter: RunListFilterInput = {
    projectId: input.projectId,
    status: input.status,
    since: deps.nowMs - input.sinceDays * DAY_MS,
  };

  const [rows, total] = await Promise.all([
    deps.store.list({
      ...filter,
      limit: RUN_PAGE_SIZE,
      offset: (input.page - 1) * RUN_PAGE_SIZE,
      sort: input.sort,
      order: input.order,
    }),
    deps.store.count(filter),
  ]);

  return {
    items: rows.map((row) => toRunSummary(row, deps.guildId)),
    total,
    page: input.page,
    pageSize: RUN_PAGE_SIZE,
  };
};
