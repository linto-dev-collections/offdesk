export type Clock = {
  readonly nowMs: () => number;
};

export const elapsedMs = (sinceMs: number, nowMs: number): number =>
  nowMs - sinceMs;

export const hasElapsed = (
  sinceMs: number,
  nowMs: number,
  windowMs: number,
): boolean => elapsedMs(sinceMs, nowMs) >= windowMs;
