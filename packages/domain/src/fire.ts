export const FIRE_URL_PREFIX = "https://api.anthropic.com/";

export const isFireUrlAllowed = (url: string): boolean =>
  url.startsWith(FIRE_URL_PREFIX);

export const hostOf = (url: string): string => {
  const afterScheme = url.indexOf("://");
  if (afterScheme < 0) return "";

  const rest = url.slice(afterScheme + 3);
  const end = rest.search(/[/?#]/);
  const authority = end < 0 ? rest : rest.slice(0, end);
  const host = authority.slice(authority.lastIndexOf("@") + 1);

  return host.split(":")[0] ?? "";
};

export type FireUrlProblem = { readonly message: string };

export const checkFireUrl = (url: string): FireUrlProblem | null =>
  isFireUrlAllowed(url)
    ? null
    : { message: `fire_url が ${FIRE_URL_PREFIX} で始まっていません` };

export type FireSession = {
  readonly ccSessionId: string;
  readonly ccSessionUrl: string;
};

export type FireOutcome =
  | { readonly ok: true; readonly session: FireSession | null }
  | { readonly ok: false; readonly reason: string };
