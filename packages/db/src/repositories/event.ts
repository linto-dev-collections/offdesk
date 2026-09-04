import { and, eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { events } from "../schema/offdesk.ts";

/*
  進捗と通知の記録（テーブル定義書 §4-5）。

  **行の中身は書き換えない。** 例外は `discord_message_id` を 1 回だけ後から
  結びつけることで、これは**「出す前に台帳へ残す」を成り立たせるための順序**
  （計画 P3b §3-4 の 2 を 3 より先にやる）—— 先に出してから記録すると、
  出せなかった report が台帳から消える（要件 `N-7`）。

  **本文をログに出さない**（脅威 12）。この層は `console` を一度も呼ばない。
*/

/** DDL の `events_kind_ck` と同じ一覧。**`report` が出せるのはこのうち 3 種**（P3b）。 */
const EVENT_KINDS = [
  "progress",
  "done",
  "blocked",
  "stop_hook",
  "error",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export type EventRecord = {
  readonly id: number;
  readonly runKey: string;
  readonly kind: EventKind;
  readonly body: string;
  readonly discordMessageId: string | null;
  readonly createdAt: number;
};

export const insertEvent = async (
  db: Db,
  input: {
    readonly runKey: string;
    readonly kind: EventKind;
    readonly body: string;
  },
  nowMs: number,
): Promise<number> => {
  const [row] = await db
    .insert(events)
    .values({ ...input, createdAt: new Date(nowMs) })
    .returning({ id: events.id });

  if (row === undefined) {
    throw new Error("events の挿入が id を返しませんでした");
  }
  return row.id;
};

/**
 * 出せた Discord メッセージを結びつける。
 *
 * **出せなかったときは呼ばない** —— 列が NULL のまま並ぶことが
 * 「D1 には残っているが Discord には出ていない」の表示になる（要件 `N-7`）。
 */
export const attachEventMessage = async (
  db: Db,
  id: number,
  discordMessageId: string,
): Promise<void> => {
  await db.update(events).set({ discordMessageId }).where(eq(events.id, id));
};

/** run 詳細の時系列（`events_run_id_idx`）。**id の昇順が起きた順**（P7a が使う）。 */
export const listEvents = async (
  db: Db,
  runKey: string,
): Promise<readonly EventRecord[]> => {
  const rows = await db
    .select({
      id: events.id,
      runKey: events.runKey,
      kind: events.kind,
      body: events.body,
      discordMessageId: events.discordMessageId,
      createdAt: events.createdAt,
    })
    .from(events)
    .where(eq(events.runKey, runKey))
    .orderBy(events.id);

  return rows.map((row) => ({
    id: row.id,
    runKey: row.runKey,
    // `kind` は DDL の CHECK が守っているので、読み出しでは信じる（`run.ts` と同じ判断）。
    kind: row.kind as EventKind,
    body: row.body,
    discordMessageId: row.discordMessageId,
    createdAt: row.createdAt.getTime(),
  }));
};

/**
 * その種の記録が既にあるか（P5 §3-4 の「枠を二重に出さない」）。
 *
 * **`listEvents` を使わない。** `stop_hook` は 1 ターンごとに 1 行増えるので、
 * 長いセッションでは全件を読むことになる —— 見たいのは
 * 「`done` が 1 行でもあるか」だけ（`events_run_id_idx` が run_key で引ける）。
 */
export const hasEventOfKind = async (
  db: Db,
  runKey: string,
  kind: EventKind,
): Promise<boolean> => {
  const [row] = await db
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.runKey, runKey), eq(events.kind, kind)))
    .limit(1);

  return row !== undefined;
};
