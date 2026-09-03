const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

const pad = (value: number, width: number): string =>
  String(value).padStart(width, "0");

const toJstClock = (epochMs: number): Date => new Date(epochMs + JST_OFFSET_MS);

export const formatJstDate = (epochMs: number): string => {
  const jst = toJstClock(epochMs);
  return `${pad(jst.getUTCFullYear(), 4)}-${pad(jst.getUTCMonth() + 1, 2)}-${pad(jst.getUTCDate(), 2)}`;
};

export const formatJst = (epochMs: number): string => {
  const jst = toJstClock(epochMs);
  return `${formatJstDate(epochMs)} ${pad(jst.getUTCHours(), 2)}:${pad(jst.getUTCMinutes(), 2)}`;
};
