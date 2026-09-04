import type { PlanScopeKind } from "@offdesk/domain";
import { eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { plans } from "../schema/offdesk.ts";

export type PlanRecord = {
  readonly planId: string;
  readonly scopeKind: PlanScopeKind;
  readonly scopeId: string;
  readonly slug: string;
  readonly lastPublishedRunKey: string;
  /** **控え**（テーブル定義書 §4-7）。正本は R2 のオブジェクト一覧。 */
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly createdAt: number;
  readonly updatedAt: number;
};

const PLAN_COLUMNS = {
  planId: plans.planId,
  scopeKind: plans.scopeKind,
  scopeId: plans.scopeId,
  slug: plans.slug,
  lastPublishedRunKey: plans.lastPublishedRunKey,
  fileCount: plans.fileCount,
  totalBytes: plans.totalBytes,
  createdAt: plans.createdAt,
  updatedAt: plans.updatedAt,
} as const;

type PlanRow = {
  planId: string;
  scopeKind: string;
  scopeId: string;
  slug: string;
  lastPublishedRunKey: string;
  fileCount: number;
  totalBytes: number;
  createdAt: Date;
  updatedAt: Date;
};

/** `scope_kind` は `plans_scope_kind_ck` が守っているので、読み出しでは信じる。 */
const toPlanRecord = (row: PlanRow): PlanRecord => ({
  planId: row.planId,
  scopeKind: row.scopeKind as PlanScopeKind,
  scopeId: row.scopeId,
  slug: row.slug,
  lastPublishedRunKey: row.lastPublishedRunKey,
  fileCount: row.fileCount,
  totalBytes: row.totalBytes,
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime(),
});

export const upsertPlan = async (
  db: Db,
  input: {
    readonly planId: string;
    readonly scopeKind: PlanScopeKind;
    readonly scopeId: string;
    readonly slug: string;
    readonly runKey: string;
  },
  nowMs: number,
): Promise<PlanRecord> => {
  const [row] = await db
    .insert(plans)
    .values({
      planId: input.planId,
      scopeKind: input.scopeKind,
      scopeId: input.scopeId,
      slug: input.slug,
      lastPublishedRunKey: input.runKey,
      createdAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
    })
    .onConflictDoUpdate({
      target: [plans.scopeKind, plans.scopeId, plans.slug],
      set: {
        lastPublishedRunKey: input.runKey,
        updatedAt: new Date(nowMs),
      },
    })
    .returning(PLAN_COLUMNS);

  if (row === undefined) {
    throw new Error(`計画の行を確保できませんでした: ${input.slug}`);
  }

  return toPlanRecord(row);
};

/**
 * 置き終わりの控えを入れる（テーブル定義書 §4-7）。
 *
 * **正本は R2。** この 2 列は管理画面の一覧のためだけにあり、閲覧のときは
 * 必ず R2 を引く（入口のファイルを選ぶのに一覧が要る）。
 */
export const finishPlan = async (
  db: Db,
  input: {
    readonly planId: string;
    readonly fileCount: number;
    readonly totalBytes: number;
  },
  nowMs: number,
): Promise<void> => {
  await db
    .update(plans)
    .set({
      fileCount: input.fileCount,
      totalBytes: input.totalBytes,
      updatedAt: new Date(nowMs),
    })
    .where(eq(plans.planId, input.planId));
};

export const findPlan = async (
  db: Db,
  planId: string,
): Promise<PlanRecord | null> => {
  const [row] = await db
    .select(PLAN_COLUMNS)
    .from(plans)
    .where(eq(plans.planId, planId))
    .limit(1);

  return row === undefined ? null : toPlanRecord(row);
};

export const deletePlan = async (db: Db, planId: string): Promise<boolean> => {
  const rows = await db
    .delete(plans)
    .where(eq(plans.planId, planId))
    .returning({ planId: plans.planId });

  return rows.length > 0;
};
