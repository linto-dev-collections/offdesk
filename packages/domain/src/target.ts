import { assertNever } from "./assert-never.ts";

export type RunTarget =
  | { readonly kind: "issue"; readonly number: number }
  | { readonly kind: "pull"; readonly number: number }
  | { readonly kind: "none" };

export const NO_TARGET: RunTarget = { kind: "none" };

export type RunTargetProblem = { readonly problem: string };
export type RunTargetResolution = RunTarget | RunTargetProblem;

export const isRunTargetProblem = (
  value: RunTargetResolution,
): value is RunTargetProblem => "problem" in value;

const positiveInteger = (value: unknown): number | null => {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number") return null;
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
};

export const parseRunTarget = (input: {
  readonly issue?: unknown;
  readonly pr?: unknown;
}): RunTargetResolution => {
  const issue = input.issue ?? undefined;
  const pr = input.pr ?? undefined;

  if (issue !== undefined && pr !== undefined) {
    return { problem: "issue と pr はどちらか 1 つにしてください。" };
  }
  if (issue !== undefined) {
    const number = positiveInteger(issue);
    return number === null
      ? { problem: "issue は 1 以上の整数で指定してください。" }
      : { kind: "issue", number };
  }
  if (pr !== undefined) {
    const number = positiveInteger(pr);
    return number === null
      ? { problem: "pr は 1 以上の整数で指定してください。" }
      : { kind: "pull", number };
  }
  return NO_TARGET;
};

export const BRANCH_PREFIX = "claude/";

const BRANCH_SUFFIX_LENGTH = 8;

export const branchSuffix = (runKey: string): string =>
  runKey.slice(-BRANCH_SUFFIX_LENGTH);

export const branchFor = (target: RunTarget): string | null =>
  target.kind === "issue" ? `${BRANCH_PREFIX}issue-${target.number}` : null;

const THREAD_PREFIX = "OFFDESK";
const ISSUE_MARK = "#";
const PULL_MARK = "PR#";

export const threadPrefix = (target: RunTarget): string => {
  switch (target.kind) {
    case "issue":
      return `${THREAD_PREFIX} ${ISSUE_MARK}${target.number}`;
    case "pull":
      return `${THREAD_PREFIX} ${PULL_MARK}${target.number}`;
    case "none":
      return THREAD_PREFIX;
    default:
      return assertNever(target);
  }
};

const THREAD_TARGET = new RegExp(
  `^${THREAD_PREFIX} (${PULL_MARK}|${ISSUE_MARK})(\\d+)(?:\\s|$)`,
);

export const parseThreadPrefix = (threadName: string): RunTarget => {
  const match = THREAD_TARGET.exec(threadName);
  if (match === null) return NO_TARGET;

  const number = positiveInteger(match[2]);
  if (number === null) return NO_TARGET;

  return match[1] === PULL_MARK
    ? { kind: "pull", number }
    : { kind: "issue", number };
};

export const targetLabel = (target: RunTarget): string | null => {
  switch (target.kind) {
    case "issue":
      return `Issue #${target.number}`;
    case "pull":
      return `PR #${target.number}`;
    case "none":
      return null;
    default:
      return assertNever(target);
  }
};

export const targetUrl = (
  target: RunTarget,
  repoUrl: string,
): string | null => {
  if (target.kind === "none") return null;

  const base = repoUrl.replace(/\/+$/, "").replace(/\.git$/, "");
  if (base === "") return null;

  return `${base}/${target.kind === "issue" ? "issues" : "pull"}/${target.number}`;
};
