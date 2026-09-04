import { z } from "zod";

/** DDL の `runs_status_ck` と同じ一覧（テーブル定義書 §4-3）。 */
export const RUN_STATUSES = [
  "queued",
  "running",
  "waiting",
  "done",
  "failed",
  "abandoned",
] as const;

export const RunStatus = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof RunStatus>;

/*
  **件数と状態のまとまりはここに置かない。** ページの大きさ（`RUN_PAGE_SIZE`）と
  一覧に出す `prompt` の長さ、ダッシュボードの 3 枚の件数は
  `packages/usecase` にある —— 画面はサーバーが返した `pageSize` を読むので
  クライアントには要らず、契約に置くと「使われない定数が公開面に並ぶ」。
*/

export const RUN_SINCE_DAYS_DEFAULT = 30;
export const RUN_SINCE_DAYS_MAX = 365;

/**
 * **並び替えは列名の allowlist**（plans/security.md 脅威 11）。
 *
 * `z.enum` にしてあるのが対策そのもの —— 受け取った文字列をそのまま
 * `ORDER BY` に入れる実装が**書けなくなる**（`packages/db` 側は
 * この 2 値で引ける表を持つ）。
 */
export const RunSort = z.enum(["createdAt", "updatedAt"]);
export type RunSort = z.infer<typeof RunSort>;

export const RunOrder = z.enum(["asc", "desc"]);
export type RunOrder = z.infer<typeof RunOrder>;

/**
 * 一覧の絞り込みとページング（要件 `F-F2`）。
 *
 * **これ 1 本を `validateSearch` と oRPC の入力の両方に使う。** 2 本に分けると
 * 「URL の検証だけ緩い」状態が作れてしまう。
 *
 * **全フィールドが `.catch()` か `.default()` を持つ ＝ この parse は失敗しない。**
 * 不正な search params で画面が壊れないことがそれで決まる（完了条件）。
 * 手で作った RPC 要求で `sort=prompt` を送っても 400 にはならず既定値に倒れるが、
 * **allowlist 外の文字列が SQL に届かない**ことは変わらない（脅威 11）。
 *
 * 期間は「何日前から」で受ける。**日付そのものを受けない** ——
 * 時刻の解釈（JST の境界）を 1 か所に閉じるため。
 */
export const RunListQuery = z.object({
  projectId: z.string().min(1).optional().catch(undefined),
  status: RunStatus.optional().catch(undefined),
  sinceDays: z.coerce
    .number()
    .int()
    .min(1)
    .max(RUN_SINCE_DAYS_MAX)
    .default(RUN_SINCE_DAYS_DEFAULT)
    .catch(RUN_SINCE_DAYS_DEFAULT),
  page: z.coerce.number().int().min(1).default(1).catch(1),
  sort: RunSort.default("createdAt").catch("createdAt"),
  order: RunOrder.default("desc").catch("desc"),
});
export type RunListQuery = z.infer<typeof RunListQuery>;

/**
 * 一覧の 1 行。
 *
 * **`prompt` は切ったものが入る**（切る長さは `packages/usecase`）。
 * **`threadUrl` と `ccSessionUrl` は無ければ `null`** —— `undefined` にすると
 * JSON からキーが消えて、出力検証が「無い」と「付け忘れ」を区別できない。
 */
export const RunSummary = z.object({
  runKey: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  status: RunStatus,
  prompt: z.string(),
  promptTruncated: z.boolean(),
  threadUrl: z.string().nullable(),
  createdAt: z.number().int(),
  finishedAt: z.number().int().nullable(),
  /** 分子が 1 度も届いていなければ `null`（要件 `F-D4`）。 */
  contextPercent: z.number().nullable(),
});
export type RunSummary = z.infer<typeof RunSummary>;

export const RunListOutput = z.object({
  items: z.array(RunSummary),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
export type RunListOutput = z.infer<typeof RunListOutput>;

export const RunDetailInput = z.object({
  runKey: z.string().min(1),
});
export type RunDetailInput = z.infer<typeof RunDetailInput>;

export const EventKind = z.enum([
  "progress",
  "done",
  "blocked",
  "stop_hook",
  "error",
]);
export type EventKind = z.infer<typeof EventKind>;

/**
 * 時系列の 1 行（`asks` / `events` / `inbox` を混ぜたもの。テーブル定義書 §6）。
 *
 * **`discriminatedUnion` にするのが要点。** 画面側で `switch` ＋ `assertNever` が
 * 書けるので、**種別を足したときに描画の分岐漏れがコンパイルエラーになる。**
 */
export const TimelineEntry = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ask"),
    at: z.number().int(),
    question: z.string(),
    options: z.array(z.string()),
    answer: z.string().nullable(),
    answeredAt: z.number().int().nullable(),
    /** Claude へ書き出せた時点（要件 `I-3`）。立っていなければ答えは宙に浮いている。 */
    deliveredAt: z.number().int().nullable(),
  }),
  z.object({
    kind: z.literal("event"),
    at: z.number().int(),
    eventKind: EventKind,
    body: z.string(),
    /** NULL ＝ 台帳には残っているが Discord には出ていない（要件 `N-7`）。 */
    discordMessageId: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("inbox"),
    at: z.number().int(),
    body: z.string(),
    takenAt: z.number().int().nullable(),
    /** **どの実行に届いたのか**（テーブル定義書 §4-6）。渡した先は届いた先と違うことがある。 */
    takenByRunKey: z.string().nullable(),
  }),
]);
export type TimelineEntry = z.infer<typeof TimelineEntry>;

/**
 * run 詳細。**`prompt` は全文**（調査に要る）。
 *
 * `contextUsedTokens` / `contextWindowTokens` を両方返すのは、`contextPercent` が
 * 100 を超えたときに**分母がモデルと合っていない**ことが読み取れるようにするため
 * （要件 `F-D4` の「203% は隠さない」と同じ判断）。
 */
export const RunDetailOutput = z.object({
  runKey: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  repoUrl: z.string(),
  status: RunStatus,
  prompt: z.string(),
  requesterDiscordUserId: z.string(),
  threadUrl: z.string().nullable(),
  ccSessionUrl: z.string().nullable(),
  createdAt: z.number().int(),
  finishedAt: z.number().int().nullable(),
  failureReason: z.string().nullable(),
  heldAt: z.number().int().nullable(),
  activityAt: z.number().int().nullable(),
  contextPercent: z.number().nullable(),
  contextUsedTokens: z.number().int().nullable(),
  contextWindowTokens: z.number().int(),
  contextAt: z.number().int().nullable(),
  contextModel: z.string().nullable(),
  /** モデル名から窓を引けたか（要件 `F-D4`）。false なら `%` は目安。 */
  contextWindowKnown: z.boolean(),
  timeline: z.array(TimelineEntry),
});
export type RunDetailOutput = z.infer<typeof RunDetailOutput>;
