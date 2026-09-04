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

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const formatRelativeJst = (epochMs: number, nowMs: number): string => {
  const elapsed = nowMs - epochMs;
  if (elapsed < MINUTE_MS) return "たった今";
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)} 分前`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)} 時間前`;
  return `${Math.floor(elapsed / DAY_MS)} 日前`;
};

export const formatDuration = (ms: number): string => {
  if (ms < SECOND_MS) return "< 1 秒";
  if (ms < MINUTE_MS) return `${Math.floor(ms / SECOND_MS)} 秒`;
  if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)} 分`;

  const hours = Math.floor(ms / HOUR_MS);
  const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS);
  return minutes === 0 ? `${hours} 時間` : `${hours} 時間 ${minutes} 分`;
};
