export const DISCORD_MESSAGE_MAX = 2_000;
export const DISCORD_EMBED_TITLE_MAX = 256;
export const DISCORD_EMBED_DESCRIPTION_MAX = 4_096;
export const DISCORD_EMBED_FIELD_VALUE_MAX = 1_024;
export const DISCORD_THREAD_NAME_MAX = 100;

const ELLIPSIS = "…";

export const truncate = (value: string, max: number): string => {
  if (max <= 0) return "";
  if (value.length <= max) return value;
  if (max <= ELLIPSIS.length) return value.slice(0, max);
  return value.slice(0, max - ELLIPSIS.length) + ELLIPSIS;
};

export const threadName = (prefix: string, prompt: string): string => {
  const flat = prompt.replace(/\s+/g, " ").trim();
  const head = `${prefix} `;
  return truncate(`${head}${flat}`, DISCORD_THREAD_NAME_MAX);
};
