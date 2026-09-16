import { discordChannelUrl, hostOf } from "@offdesk/domain";

export type ProjectSummaryView = {
  readonly id: string;
  readonly name: string;
  readonly discordChannelId: string;
  readonly channelUrl: string | null;
  readonly repoUrl: string;
  readonly fireUrlHost: string;
  readonly fireTokenLast4: string | null;
  readonly disabled: boolean;
};

export type ProjectStoreReadPort = {
  readonly listWithMask: () => Promise<
    readonly {
      readonly id: string;
      readonly name: string;
      readonly discordChannelId: string;
      readonly repoUrl: string;
      readonly fireUrl: string;
      readonly fireTokenLast4: string | null;
      readonly disabledAt: number | null;
    }[]
  >;
};

export type ListProjectsDeps = {
  readonly store: ProjectStoreReadPort;
  readonly guildId: string | null;
};

/**
 * 行 1 つを画面へ出す姿に畳む（plans/security.md 脅威 3）。
 *
 * **`fireUrl` は host だけに畳んでから外へ出す。** URL 全体には `trig_…` が埋まっていて、
 * それ 1 つで（トークンがあれば）起動できる。
 *
 * **一覧と書き込みの応答で同じ関数を通す**（`write-project.ts` が呼ぶ）。
 * 2 か所に分けると、**書いた直後だけ `fireUrl` 全体が返る**ような取りこぼしが作れる。
 */
export const toProjectSummary = (
  row: {
    readonly id: string;
    readonly name: string;
    readonly discordChannelId: string;
    readonly repoUrl: string;
    readonly fireUrl: string;
    readonly fireTokenLast4: string | null;
    readonly disabledAt: number | null;
  },
  guildId: string | null,
): ProjectSummaryView => ({
  id: row.id,
  name: row.name,
  discordChannelId: row.discordChannelId,
  channelUrl: discordChannelUrl({
    guildId,
    channelId: row.discordChannelId,
  }),
  repoUrl: row.repoUrl,
  fireUrlHost: hostOf(row.fireUrl),
  fireTokenLast4: row.fireTokenLast4,
  disabled: row.disabledAt !== null,
});

/** 一覧（要件 `F-F3`）。**無効なものも含む**（要件 `F-H5` の棚卸し）。 */
export const listProjectSummaries = async (
  deps: ListProjectsDeps,
): Promise<readonly ProjectSummaryView[]> => {
  const rows = await deps.store.listWithMask();

  return rows.map((row) => toProjectSummary(row, deps.guildId));
};
