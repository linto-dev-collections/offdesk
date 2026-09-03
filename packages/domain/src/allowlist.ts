export type EmailGate =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

export const parseAllowedEmails = (raw: string): readonly string[] =>
  raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);

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
