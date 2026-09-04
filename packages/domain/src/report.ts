import { DISCORD_MESSAGE_MAX } from "./discord/limits.ts";

/*
  `report` が受け取れるもの（計画 P3b §3-4）。

  **`events.kind` の 5 種のうち 3 種だけを口に出す。** `stop_hook`（P5）と
  `error`（P8）は offdesk 自身が書く種で、Claude に選ばせるものではない ——
  一覧を 1 つにまとめると、routine が `error` を書けるようになる。
*/

export const REPORT_KINDS = ["progress", "done", "blocked"] as const;

export type ReportKind = (typeof REPORT_KINDS)[number];

/** 本文は Discord のメッセージ 1 通に収まる範囲。長い文書は R2 へ置く（P6）。 */
export const MAX_REPORT_BODY_LENGTH = DISCORD_MESSAGE_MAX - 200;

export type ReportProblem = { readonly problem: string };

export type ValidReport = {
  readonly kind: ReportKind;
  readonly body: string;
};

export type ReportValidation = ValidReport | ReportProblem;

export const isReportProblem = (
  value: ReportValidation,
): value is ReportProblem => "problem" in value;

/**
 * **状態が変わったときだけ枠を付ける**（要件 `F-B5`）。
 *
 * `progress` は Claude 本人の発言なので地の文。`done` / `blocked` は
 * 「この run で何が起きたか」が変わった合図なので枠を付ける。
 */
export const isStateChange = (kind: ReportKind): boolean => kind !== "progress";

export const validateReport = (input: {
  readonly kind: unknown;
  readonly body: unknown;
}): ReportValidation => {
  const kind = input.kind;
  if (
    typeof kind !== "string" ||
    !(REPORT_KINDS as readonly string[]).includes(kind)
  ) {
    return {
      problem: `kind は ${REPORT_KINDS.join(" / ")} のどれかにしてください（受け取った値: ${typeof kind === "string" ? kind : typeof kind}）。`,
    };
  }

  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (body === "") return { problem: "body が空です。" };
  if (body.length > MAX_REPORT_BODY_LENGTH) {
    return {
      problem: `body が長すぎます（${body.length} 字 / 上限 ${MAX_REPORT_BODY_LENGTH} 字）。長い文書は Discord に入らないので、要点だけを渡してください。`,
    };
  }

  return { kind: kind as ReportKind, body };
};
