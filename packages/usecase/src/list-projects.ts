import { hostOf } from "@offdesk/domain";

export type ProjectSummaryView = {
  readonly id: string;
  readonly name: string;
  readonly discordChannelId: string;
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

/**
 * 一覧（要件 `F-F3`・plans/security.md 脅威 3）。
 *
 * **`fireUrl` は host だけに畳んでから外へ出す。** URL 全体には `trig_…` が埋まっていて、
 * それ 1 つで（トークンがあれば）起動できる。
 */
export const listProjectSummaries = async (
  store: ProjectStoreReadPort,
): Promise<readonly ProjectSummaryView[]> => {
  const rows = await store.listWithMask();

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    discordChannelId: row.discordChannelId,
    repoUrl: row.repoUrl,
    fireUrlHost: hostOf(row.fireUrl),
    fireTokenLast4: row.fireTokenLast4,
    disabled: row.disabledAt !== null,
  }));
};
