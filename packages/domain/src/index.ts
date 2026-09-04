export type { EmailGate } from "./allowlist.ts";
export { gateEmail, parseAllowedEmails } from "./allowlist.ts";
export type {
  AnswerAction,
  AskProblem,
  AskValidation,
  ValidAsk,
} from "./ask.ts";
export {
  answerCustomId,
  isAskProblem,
  MAX_ASK_OPTIONS,
  MAX_ASK_QUESTION_LENGTH,
  MIN_ASK_OPTIONS,
  parseAnswerCustomId,
  validateAsk,
} from "./ask.ts";
export { assertNever } from "./assert-never.ts";
export {
  DISCORD_ACTION_ROWS_MAX,
  DISCORD_BUTTON_LABEL_MAX,
  DISCORD_BUTTONS_PER_ROW,
  DISCORD_CUSTOM_ID_MAX,
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
export type { HoldConfig, HoldOverrides } from "./hold.ts";
export {
  ASK_HOLD_MS,
  ASK_POLL_MS,
  ASK_PROGRESS_MS,
  ASK_SILENT_HOLD_MS,
  ASK_TOUCH_MS,
  CLIENT_IDLE_ABORT_MS,
  HELD_ALIVE_MS,
  holdLimitMs,
  isHeldAlive,
  OBSERVED_EDGE_CUTOFF_MS,
  RECOMMENDED_CLIENT_IDLE_TIMEOUT_MS,
  resolveHoldConfig,
} from "./hold.ts";
export type { RandomBytes } from "./ids.ts";
export { newAskId, newRunKey } from "./ids.ts";
export { isOwner } from "./owner.ts";
export type {
  ProjectQuery,
  ProjectRef,
  ProjectResolution,
} from "./project.ts";
export { projectNames, resolveProject } from "./project.ts";
export {
  buildFireText,
  isResendQuestion,
  MAX_FIRE_TEXT_LENGTH,
  RESEND_QUESTION,
  ROUTINE_PROMPT,
  SERVER_INSTRUCTIONS,
} from "./prompt.ts";
export {
  bearerMatches,
  constantTimeEqual,
} from "./secret/constant-time-equal.ts";
export type { Clock } from "./time.ts";
export { elapsedMs, hasElapsed } from "./time.ts";
