export const DISCORD_MESSAGE_MAX = 2_000;
export const DISCORD_EMBED_TITLE_MAX = 256;
export const DISCORD_EMBED_DESCRIPTION_MAX = 4_096;
export const DISCORD_EMBED_FIELD_VALUE_MAX = 1_024;
export const DISCORD_THREAD_NAME_MAX = 100;

/* ---- コンポーネント（P3a の回答ボタン） ---- */

export const DISCORD_BUTTON_LABEL_MAX = 80;
/** `custom_id` の上限。`ans:ask_<16hex>:<index>` は 26 文字なので収まる。 */
export const DISCORD_CUSTOM_ID_MAX = 100;
export const DISCORD_BUTTONS_PER_ROW = 5;
export const DISCORD_ACTION_ROWS_MAX = 5;

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
