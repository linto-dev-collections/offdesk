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
  readonly contextWindowTokens: number;
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
  readonly contextWindowTokens: number;
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
  contextWindowTokens: projects.contextWindowTokens,
  disabledAt: projects.disabledAt,
} as const;

type ProjectRow = {
  id: string;
  name: string;
  discordChannelId: string;
  repoUrl: string;
  fireUrl: string;
  contextWindowTokens: number;
  disabledAt: Date | null;
};

const toProjectRecord = (row: ProjectRow): ProjectRecord => ({
  id: row.id,
  name: row.name,
  discordChannelId: row.discordChannelId,
  repoUrl: row.repoUrl,
  fireUrl: row.fireUrl,
  contextWindowTokens: row.contextWindowTokens,
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
          contextWindowTokens: input.contextWindowTokens,
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
