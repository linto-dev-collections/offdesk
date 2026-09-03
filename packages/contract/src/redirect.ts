/*
  ログイン後の戻り先の検査（plans/security.md 脅威 10）。

  **`domain` ではなく `contract` に置く。** 使うのはログイン画面（client）で、
  `domain` は `client-no-server-packages` により client から import できない。
*/

/** 検査を通らなかったときに倒す先。 */
const HOME = "/";

/**
 * 制御文字を含むか。挟んで検査をすり抜ける形（`/\tjavascript:` など）を落とす。
 *
 * **正規表現にしない。** 制御文字の範囲を書くと Biome の
 * `noControlCharactersInRegex` に当たる——あの規則は一般には正しいので、
 * 例外を作るより符号点を直に見る方がよい（読んで分かる形にもなる）。
 */
const hasControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

/**
 * 自サイト内のパスだけを通す。それ以外は `/` に倒す。
 *
 * 通すのは**`/` 1 つで始まる相対パスだけ。** 落とすもの:
 *
 * | 入力 | なぜ落とすか |
 * | --- | --- |
 * | `//evil.example.com` | プロトコル相対 URL。ブラウザは別ホストとして解決する |
 * | `https://evil.example.com` | 絶対 URL |
 * | `javascript:alert(1)` | スキーム付き |
 * | `/\evil.example.com` | ブラウザが `//` と同じに解釈することがある |
 * | `runs` | 相対パス。現在地に依存して意図しない先へ行く |
 */
export const safeRedirectPath = (raw: string | undefined): string => {
  if (raw === undefined) return HOME;

  const value = raw.trim();
  if (!value.startsWith("/")) return HOME;
  if (value.startsWith("//") || value.startsWith("/\\")) return HOME;
  if (hasControlCharacter(value)) return HOME;

  return value;
};
