export type ProjectRef = {
  readonly name: string;
  readonly discordChannelId: string;
};

export type ProjectResolution<T extends ProjectRef> =
  | { readonly kind: "resolved"; readonly project: T }
  | { readonly kind: "unknown-name"; readonly requested: string }
  | { readonly kind: "no-binding" };

export type ProjectQuery = {
  readonly name?: string | undefined;
  readonly channelId?: string | undefined;
  readonly parentId?: string | undefined;
};

export const resolveProject = <T extends ProjectRef>(
  projects: readonly T[],
  query: ProjectQuery,
): ProjectResolution<T> => {
  const requested = query.name?.trim();
  if (requested !== undefined && requested !== "") {
    const named = projects.find((project) => project.name === requested);
    return named === undefined
      ? { kind: "unknown-name", requested }
      : { kind: "resolved", project: named };
  }

  for (const channelId of [query.parentId, query.channelId]) {
    if (channelId === undefined || channelId === "") continue;
    const bound = projects.find(
      (project) => project.discordChannelId === channelId,
    );
    if (bound !== undefined) return { kind: "resolved", project: bound };
  }

  return { kind: "no-binding" };
};

export const projectNames = (projects: readonly ProjectRef[]): string =>
  projects.map((project) => project.name).join(" / ");
