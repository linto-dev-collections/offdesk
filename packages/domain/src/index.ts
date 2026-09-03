export type { EmailGate } from "./allowlist.ts";
export { gateEmail, parseAllowedEmails } from "./allowlist.ts";
export { assertNever } from "./assert-never.ts";
export {
  DISCORD_EMBED_DESCRIPTION_MAX,
  DISCORD_EMBED_FIELD_VALUE_MAX,
  DISCORD_EMBED_TITLE_MAX,
  DISCORD_MESSAGE_MAX,
  DISCORD_THREAD_NAME_MAX,
  threadName,
  truncate,
} from "./discord/limits.ts";
export type {
  FireOutcome,
  FireSession,
  FireUrlProblem,
} from "./fire.ts";
export {
  checkFireUrl,
  FIRE_URL_PREFIX,
  hostOf,
  isFireUrlAllowed,
} from "./fire.ts";
export type { Health } from "./health.ts";
export type { RandomBytes } from "./ids.ts";
export { newRunKey } from "./ids.ts";
export { isOwner } from "./owner.ts";
export type {
  ProjectQuery,
  ProjectRef,
  ProjectResolution,
} from "./project.ts";
export { projectNames, resolveProject } from "./project.ts";
export {
  buildFireText,
  MAX_FIRE_TEXT_LENGTH,
  ROUTINE_PROMPT,
} from "./prompt.ts";
export {
  bearerMatches,
  constantTimeEqual,
} from "./secret/constant-time-equal.ts";
export type { Clock } from "./time.ts";
export { elapsedMs, hasElapsed } from "./time.ts";
