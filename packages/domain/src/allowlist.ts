/*
  誰がログインできるか（要件 `F-G3`・`I-2`）。

  判定を純粋関数にしてある。Better Auth の `validateUserInfo` の中に直接書くと、検査するのに Google の OAuth を踏むしかなくなる。
  要件 `I-2`（allowlist が空なら誰も通さない）は落としやすい規則なので、境界を全部テストで固められる形に置く。
*/

export type EmailGate =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

/**
 * `,` 区切りの allowlist を正規化する。
 *
 * 空文字を落とすのが要点。落とさないと `AUTH_ALLOWED_EMAILS=""` が「空文字のメールを許可」になり、メールを持たない ID 連携で全開になる（空文字どうしは一致する）。
 */
export const parseAllowedEmails = (raw: string): readonly string[] =>
  raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);

/**
 * このメールを通すか。
 *
 * 空 allowlist の分岐を先に書く（要件 `I-2`）。後ろに書くと、「未設定なら全部許可」に倒す実装へ滑りやすい。
 */
export const gateEmail = (
  allowed: readonly string[],
  email: string | undefined,
): EmailGate => {
  if (allowed.length === 0) {
    return { allowed: false, reason: "許可リストが未設定です" };
  }

  const normalized = email?.trim().toLowerCase();
  if (normalized === undefined || normalized.length === 0) {
    return { allowed: false, reason: "メールアドレスがありません" };
  }
  if (!allowed.includes(normalized)) {
    return { allowed: false, reason: "このメールアドレスは許可されていません" };
  }

  return { allowed: true };
};
