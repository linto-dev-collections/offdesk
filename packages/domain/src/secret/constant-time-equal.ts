export const constantTimeEqual = (a: string, b: string): boolean => {
  let diff = a.length ^ b.length;

  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const left = i < a.length ? a.charCodeAt(i) : 0;
    const right = i < b.length ? b.charCodeAt(i) : 0;
    diff |= left ^ right;
  }

  return diff === 0;
};

export const bearerMatches = (
  header: string | undefined,
  configured: string | undefined,
): boolean => {
  const expected = configured?.trim() ?? "";
  if (expected === "") return false;

  const prefix = "Bearer ";
  if (header === undefined || !header.startsWith(prefix)) return false;

  return constantTimeEqual(header.slice(prefix.length).trim(), expected);
};
