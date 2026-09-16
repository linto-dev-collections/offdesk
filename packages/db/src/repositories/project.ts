import { createId } from "@paralleldrive/cuid2";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../client.ts";
import type { EncryptedFireToken } from "../crypto/fire-token.ts";
import { decryptFireToken } from "../crypto/fire-token.ts";
import { projectFireCredentials, projects } from "../schema/offdesk.ts";
import { toBytes } from "./bytes.ts";

/*
  SQL を持つのはこのファイルだけ（要件 `I-12`）。返すのは行の dict ではなく、
  ここで定義した record 型。Drizzle の型がユースケース層へ漏れない。
*/

/** 一覧・起動が使う形。**暗号文を持たない**（テーブル定義書 §4-2 の 1 つ目の理由）。 */
export type ProjectRecord = {
  readonly id: string;
  readonly name: string;
  readonly discordChannelId: string;
  readonly repoUrl: string;
  readonly fireUrl: string;
  readonly disabledAt: number | null;
};

export type ProjectWithMaskRecord = ProjectRecord & {
  readonly fireTokenLast4: string | null;
};

export type UpsertProjectInput = {
  readonly name: string;
  readonly discordChannelId: string;
  readonly repoUrl: string;
  readonly fireUrl: string;
};

/*
  **暗号文を選ぶ列を書かない。** `SELECT *` を避けるのではなく、
  「触れない形」にしておく（要件 `I-1` を気をつけるのではなく構造で守る）。
*/
const PROJECT_COLUMNS = {
  id: projects.id,
  name: projects.name,
  discordChannelId: projects.discordChannelId,
  repoUrl: projects.repoUrl,
  fireUrl: projects.fireUrl,
  disabledAt: projects.disabledAt,
} as const;

type ProjectRow = {
  id: string;
  name: string;
  discordChannelId: string;
  repoUrl: string;
  fireUrl: string;
  disabledAt: Date | null;
};

const toProjectRecord = (row: ProjectRow): ProjectRecord => ({
  id: row.id,
  name: row.name,
  discordChannelId: row.discordChannelId,
  repoUrl: row.repoUrl,
  fireUrl: row.fireUrl,
  disabledAt: row.disabledAt?.getTime() ?? null,
});

/** 有効なプロジェクト（`disabled_at IS NULL`）だけ。 */
export const listProjects = async (
  db: Db,
): Promise<readonly ProjectRecord[]> => {
  const rows = await db
    .select(PROJECT_COLUMNS)
    .from(projects)
    .where(isNull(projects.disabledAt))
    .orderBy(projects.name);

  return rows.map(toProjectRecord);
};

/** 無効なものも含む一覧。画面（`projects.list`）用にマスクを添える。 */
export const listProjectsWithMask = async (
  db: Db,
): Promise<readonly ProjectWithMaskRecord[]> => {
  const rows = await db
    .select({ ...PROJECT_COLUMNS, last4: projectFireCredentials.last4 })
    .from(projects)
    .leftJoin(
      projectFireCredentials,
      eq(projectFireCredentials.projectId, projects.id),
    )
    .orderBy(projects.name);

  return rows.map((row) => ({
    ...toProjectRecord(row),
    fireTokenLast4: row.last4,
  }));
};

/** 書いたあとに 1 件だけ引き直す（画面へ返す姿を作るため）。 */
export const findProjectWithMaskById = async (
  db: Db,
  id: string,
): Promise<ProjectWithMaskRecord | null> => {
  const [row] = await db
    .select({ ...PROJECT_COLUMNS, last4: projectFireCredentials.last4 })
    .from(projects)
    .leftJoin(
      projectFireCredentials,
      eq(projectFireCredentials.projectId, projects.id),
    )
    .where(eq(projects.id, id))
    .limit(1);

  return row === undefined
    ? null
    : { ...toProjectRecord(row), fireTokenLast4: row.last4 };
};

export const findProjectById = async (
  db: Db,
  id: string,
): Promise<ProjectRecord | null> => {
  const [row] = await db
    .select(PROJECT_COLUMNS)
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1);

  return row === undefined ? null : toProjectRecord(row);
};

/** `projects_channel_uidx` を使う。無効なプロジェクトは引かない。 */
export const findProjectByChannel = async (
  db: Db,
  channelId: string,
): Promise<ProjectRecord | null> => {
  const [row] = await db
    .select(PROJECT_COLUMNS)
    .from(projects)
    .where(
      and(
        eq(projects.discordChannelId, channelId),
        isNull(projects.disabledAt),
      ),
    )
    .limit(1);

  return row === undefined ? null : toProjectRecord(row);
};

/**
 * プロジェクトと資格情報を**1 回の batch で**入れる（D1 は対話的トランザクションを
 * 持たないので batch が原子性の単位）。片方だけ入ると「有効なのにトークンが無い」に
 * なるので、分けて実行しない。
 *
 * 自然キーは `name`。**衝突したら id は動かさない**（`runs.project_id` が指しているため）。
 */
export const upsertProjectWithCredential = async (
  db: Db,
  input: UpsertProjectInput,
  encrypted: EncryptedFireToken,
): Promise<{ readonly projectId: string; readonly inserted: boolean }> => {
  const [existing] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.name, input.name))
    .limit(1);

  const projectId = existing?.id ?? createId();

  await db.batch([
    db
      .insert(projects)
      .values({ id: projectId, ...input })
      .onConflictDoUpdate({
        target: projects.name,
        set: {
          discordChannelId: input.discordChannelId,
          repoUrl: input.repoUrl,
          fireUrl: input.fireUrl,
          updatedAt: new Date(),
        },
      }),
    db
      .insert(projectFireCredentials)
      .values({
        projectId,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        keyVersion: encrypted.keyVersion,
        last4: encrypted.last4,
      })
      .onConflictDoUpdate({
        target: projectFireCredentials.projectId,
        set: {
          ciphertext: encrypted.ciphertext,
          iv: encrypted.iv,
          keyVersion: encrypted.keyVersion,
          last4: encrypted.last4,
          updatedAt: new Date(),
        },
      }),
  ]);

  return { projectId, inserted: existing === undefined };
};

/**
 * 名前で引く。**作る前の衝突検査**（要件 `F-H4`）に使う。
 *
 * **無効なものも引く。** 止めたプロジェクトの名前を再利用させると、
 * `runs` が指している古い行と新しい行の区別が名前からは付かなくなる。
 */
export const findProjectByName = async (
  db: Db,
  name: string,
): Promise<ProjectRecord | null> => {
  const [row] = await db
    .select(PROJECT_COLUMNS)
    .from(projects)
    .where(eq(projects.name, name))
    .limit(1);

  return row === undefined ? null : toProjectRecord(row);
};

/**
 * チャンネルで引く。**無効なものも含む**（`findProjectByChannel` との違い）。
 *
 * あちらは「この発言はどのプロジェクトか」を引く hot path なので有効な行だけを見るが、
 * こちらは衝突検査 —— **止めたプロジェクトが握っているチャンネルも塞がっている**
 * （`projects_channel_uidx` は `disabled_at` を見ない）。
 */
export const findAnyProjectByChannel = async (
  db: Db,
  channelId: string,
): Promise<ProjectRecord | null> => {
  const [row] = await db
    .select(PROJECT_COLUMNS)
    .from(projects)
    .where(eq(projects.discordChannelId, channelId))
    .limit(1);

  return row === undefined ? null : toProjectRecord(row);
};

/**
 * **資格情報に触らずに**プロジェクトの行だけを書き換える。
 *
 * **`upsertProjectWithCredential` と分けてあるのが要点。** あちらは必ず暗号文を
 * 上書きするので、**チャンネルを変えるだけでもトークンを渡さないといけない** ——
 * claude.ai のトークンは発行時に 1 度しか表示されず、再発行すると前のものが
 * 失効するので、**据え置きの経路が無いとローテーションを強制することになる**
 * （`ProjectUpdateInput` の `fireToken` が任意なのはこのため）。
 *
 * 名前は引数に無い。**一致の鍵なので変えない**（OPERATIONS §2）。
 */
export const updateProjectKeepingCredential = async (
  db: Db,
  input: {
    readonly id: string;
    readonly discordChannelId: string;
    readonly repoUrl: string;
    readonly fireUrl: string;
  },
): Promise<boolean> => {
  const result = await db
    .update(projects)
    .set({
      discordChannelId: input.discordChannelId,
      repoUrl: input.repoUrl,
      fireUrl: input.fireUrl,
      updatedAt: new Date(),
    })
    .where(eq(projects.id, input.id))
    .returning({ id: projects.id });

  return result.length > 0;
};

/**
 * トークンだけを差し替える。**プロジェクトの行には触らない。**
 *
 * `projectId` は外部キーなので、存在しない id で呼ぶと D1 が落とす ——
 * 呼ぶ側（`updateProject`）が先に行の有無を確かめている。
 */
export const replaceFireCredential = async (
  db: Db,
  projectId: string,
  encrypted: EncryptedFireToken,
): Promise<void> => {
  await db
    .insert(projectFireCredentials)
    .values({
      projectId,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      keyVersion: encrypted.keyVersion,
      last4: encrypted.last4,
    })
    .onConflictDoUpdate({
      target: projectFireCredentials.projectId,
      set: {
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        keyVersion: encrypted.keyVersion,
        last4: encrypted.last4,
        updatedAt: new Date(),
      },
    });
};

/**
 * 止める・戻す（要件 `F-H5`）。**`disabled_at` を書く唯一の関数。**
 *
 * **2026-09-16 まで、この列を書くコードは 1 行も無かった** —— 読む側
 * （`listProjects` の `IS NULL`・`decideInbound` の手前・`/offdesk` の選択肢）は
 * 揃っていたのに、止めるには `wrangler d1 execute` を手で打つしかなかった
 * （OPERATIONS §2 の「止める・消す」）。
 *
 * **消す口は作らない。** `runs.project_id` が `RESTRICT` の外部キーなので、
 * run が 1 本でもあるプロジェクトは構造的に消せない —— 消せるようにすると
 * run の履歴ごと消すことになる。
 */
export const setProjectDisabled = async (
  db: Db,
  id: string,
  disabled: boolean,
  nowMs: number,
): Promise<boolean> => {
  const result = await db
    .update(projects)
    .set({
      disabledAt: disabled ? new Date(nowMs) : null,
      updatedAt: new Date(nowMs),
    })
    .where(eq(projects.id, id))
    .returning({ id: projects.id });

  return result.length > 0;
};

/**
 * **復号して返す唯一の関数。** 名前に `take` を付けてあるのは、呼ぶ場所が 1 か所である
 * ことをレビューで見つけやすくするため（`grep takeFireToken` で全経路が出る）。
 *
 * 戻り値を変数に束ねて他へ渡さない。渡す先は `fetch` の Authorization ヘッダだけ。
 */
export const takeFireToken = async (
  db: Db,
  keyBase64: string,
  projectId: string,
): Promise<string | null> => {
  const [row] = await db
    .select({
      ciphertext: projectFireCredentials.ciphertext,
      iv: projectFireCredentials.iv,
      keyVersion: projectFireCredentials.keyVersion,
    })
    .from(projectFireCredentials)
    .where(eq(projectFireCredentials.projectId, projectId))
    .limit(1);

  if (row === undefined) return null;

  return await decryptFireToken(keyBase64, {
    ciphertext: toBytes(row.ciphertext),
    iv: toBytes(row.iv),
    keyVersion: row.keyVersion,
  });
};
