import {
  contextWindowFor,
  discordThreadUrl,
  hasKnownContextWindow,
} from "@offdesk/domain";
import { contextPercentOf, type RunStatusView } from "./list-runs.ts";

/*
  run 詳細の時系列（テーブル定義書 §6・計画 P7a §3-2）。

  **`asks` / `events` / `inbox` を 3 本引いて、ここで混ぜる。** ビューや
  `UNION ALL` にしない —— D1 は複合 SELECT の項数を 5 に絞っているうえ、
  列の形が違う 3 表を 1 本に畳むと「どの表から来たか」の列を足すことになる。
  run 1 本あたり数十行なので 3 回引いても速度は問題にならない。
*/

export type TimelineEntryView =
  | {
      readonly kind: "ask";
      readonly at: number;
      readonly question: string;
      readonly options: readonly string[];
      readonly answer: string | null;
      readonly answeredAt: number | null;
      readonly deliveredAt: number | null;
    }
  | {
      readonly kind: "event";
      readonly at: number;
      readonly eventKind:
        | "progress"
        | "done"
        | "blocked"
        | "stop_hook"
        | "error";
      readonly body: string;
      readonly discordMessageId: string | null;
    }
  | {
      readonly kind: "inbox";
      readonly at: number;
      readonly body: string;
      readonly takenAt: number | null;
      readonly takenByRunKey: string | null;
    };

export type RunDetailRowView = {
  readonly runKey: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly repoUrl: string;
  readonly status: RunStatusView;
  readonly prompt: string;
  readonly requesterDiscordUserId: string;
  readonly threadId: string | null;
  readonly ccSessionUrl: string | null;
  readonly heldAt: number | null;
  readonly activityAt: number | null;
  readonly ctxUsedTokens: number | null;
  readonly ctxAt: number | null;
  readonly ctxModel: string | null;
  readonly finishedAt: number | null;
  readonly failureReason: string | null;
  readonly createdAt: number;
};

export type AskRowView = {
  readonly question: string;
  readonly options: readonly string[];
  readonly answer: string | null;
  readonly answeredAt: number | null;
  readonly deliveredAt: number | null;
  readonly createdAt: number;
};

export type EventRowView = {
  readonly kind: "progress" | "done" | "blocked" | "stop_hook" | "error";
  readonly body: string;
  readonly discordMessageId: string | null;
  readonly createdAt: number;
};

export type InboxRowView = {
  readonly body: string;
  readonly takenAt: number | null;
  readonly takenByRunKey: string | null;
  readonly createdAt: number;
};

export type RunDetailStorePort = {
  readonly find: (runKey: string) => Promise<RunDetailRowView | null>;
  readonly asks: (runKey: string) => Promise<readonly AskRowView[]>;
  readonly events: (runKey: string) => Promise<readonly EventRowView[]>;
  readonly inbox: (runKey: string) => Promise<readonly InboxRowView[]>;
};

export type RunDetailView = {
  readonly runKey: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly repoUrl: string;
  readonly status: RunStatusView;
  readonly prompt: string;
  readonly requesterDiscordUserId: string;
  readonly threadUrl: string | null;
  readonly ccSessionUrl: string | null;
  readonly createdAt: number;
  readonly finishedAt: number | null;
  readonly failureReason: string | null;
  readonly heldAt: number | null;
  readonly activityAt: number | null;
  readonly contextPercent: number | null;
  readonly contextUsedTokens: number | null;
  readonly contextWindowTokens: number;
  readonly contextAt: number | null;
  readonly contextModel: string | null;
  readonly contextWindowKnown: boolean;
  readonly timeline: readonly TimelineEntryView[];
};

/**
 * 3 表を `created_at` の昇順に混ぜる。
 *
 * **同じミリ秒に並んだ行の順序は「ask → event → inbox」。**
 * `Array.prototype.sort` は安定なので、詰める順がそのまま同着の順になる ——
 * 実物では 3 表が同じミリ秒に並ぶことはまず無いが、**テストが順序に
 * 依存するので決めておく**（決めないと落ちる日が来る）。
 */
export const mergeTimeline = (input: {
  readonly asks: readonly AskRowView[];
  readonly events: readonly EventRowView[];
  readonly inbox: readonly InboxRowView[];
}): readonly TimelineEntryView[] => {
  const entries: TimelineEntryView[] = [
    ...input.asks.map(
      (ask): TimelineEntryView => ({
        kind: "ask",
        at: ask.createdAt,
        question: ask.question,
        options: ask.options,
        answer: ask.answer,
        answeredAt: ask.answeredAt,
        deliveredAt: ask.deliveredAt,
      }),
    ),
    ...input.events.map(
      (event): TimelineEntryView => ({
        kind: "event",
        at: event.createdAt,
        eventKind: event.kind,
        body: event.body,
        discordMessageId: event.discordMessageId,
      }),
    ),
    ...input.inbox.map(
      (row): TimelineEntryView => ({
        kind: "inbox",
        at: row.createdAt,
        body: row.body,
        takenAt: row.takenAt,
        takenByRunKey: row.takenByRunKey,
      }),
    ),
  ];

  return entries.sort((left, right) => left.at - right.at);
};

/**
 * run 詳細（要件 `F-F1`）。**見つからなければ `null`。**
 *
 * **見つからないときに 3 本を引かない。** `run_key` を推測して叩かれたときに
 * 4 回のクエリを使わせない（脅威 16 と同じ、資源の使い方の話）。
 */
export const getRunDetail = async (
  deps: {
    readonly store: RunDetailStorePort;
    readonly guildId: string | null;
  },
  runKey: string,
): Promise<RunDetailView | null> => {
  const run = await deps.store.find(runKey);
  if (run === null) return null;

  const [asks, events, inbox] = await Promise.all([
    deps.store.asks(runKey),
    deps.store.events(runKey),
    deps.store.inbox(runKey),
  ]);

  return {
    runKey: run.runKey,
    projectId: run.projectId,
    projectName: run.projectName,
    repoUrl: run.repoUrl,
    status: run.status,
    prompt: run.prompt,
    requesterDiscordUserId: run.requesterDiscordUserId,
    threadUrl: discordThreadUrl({
      guildId: deps.guildId,
      threadId: run.threadId,
    }),
    ccSessionUrl: run.ccSessionUrl,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
    failureReason: run.failureReason,
    heldAt: run.heldAt,
    activityAt: run.activityAt,
    contextPercent: contextPercentOf({
      usedTokens: run.ctxUsedTokens,
      model: run.ctxModel,
    }),
    contextUsedTokens: run.ctxUsedTokens,
    contextWindowTokens: contextWindowFor(run.ctxModel),
    contextAt: run.ctxAt,
    contextModel: run.ctxModel,
    contextWindowKnown: hasKnownContextWindow(run.ctxModel),
    timeline: mergeTimeline({ asks, events, inbox }),
  };
};
