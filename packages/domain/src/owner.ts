export const isOwner = (
  ownerId: string | undefined,
  actorId: string | null | undefined,
): boolean => {
  const owner = ownerId?.trim() ?? "";
  if (owner === "") return false;

  const actor = actorId?.trim() ?? "";
  if (actor === "") return false;

  return owner === actor;
};
