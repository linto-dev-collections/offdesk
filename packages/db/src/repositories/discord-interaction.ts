import { eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { discordInteractions } from "../schema/offdesk.ts";

/*
  Discord interaction の冪等化（テーブル定義書の `discord_interactions`）。

  **署名が正しい要求は、何度送られても署名が正しい。** Ed25519 の検査は
  「Discord が作った本物か」しか言わないので、**同じ本物の再送**は止まらない ——
  1 回の起動は routine の実行回数を 1 つ消費するので、取りこぼしよりも
  二重起動の方が高い。
*/

export type InteractionKind = "command" | "component";

/**
 * その interaction を**自分が最初に受け取ったことにする。**
 *
 * `false` は「既に誰かが受け取っている」。**行が入ったかどうかを唯一の判断材料に
 * する**（先に `SELECT` して無ければ `INSERT`、にはしない）—— あいだに
 * もう 1 本入ると両方が「初めて」と判定する。
 *
 * **確保は起動より先。** 起動してから確保すると、落ちた再送が 2 本目を立てる。
 * 確保が先なので、確保のあとに落ちた要求は**再送しても通らない** ——
 * それは意図で、依頼者はもう一度 `/offdesk` を打てばよい（新しい id になる）。
 */
export const claimInteraction = async (
  db: Db,
  input: { readonly id: string; readonly kind: InteractionKind },
): Promise<boolean> => {
  const rows = await db
    .insert(discordInteractions)
    .values({ id: input.id, kind: input.kind })
    .onConflictDoNothing({ target: discordInteractions.id })
    .returning({ id: discordInteractions.id });

  return rows.length > 0;
};

/**
 * 確保した行に run を結び付ける（監査用）。
 *
 * **失敗しても何も壊れない。** 冪等の判定は `id` の有無だけで決まっていて、
 * この列は「どの `/offdesk` がどの run になったか」を後から辿るためだけにある。
 */
export const attachInteractionRun = async (
  db: Db,
  id: string,
  runKey: string,
): Promise<void> => {
  await db
    .update(discordInteractions)
    .set({ runKey })
    .where(eq(discordInteractions.id, id));
};
