export const FIRE_URL_PREFIX = "https://api.anthropic.com/";

export const isFireUrlAllowed = (url: string): boolean =>
  url.startsWith(FIRE_URL_PREFIX);

export const hostOf = (url: string): string => {
  const afterScheme = url.indexOf("://");
  if (afterScheme < 0) return "";

  const rest = url.slice(afterScheme + 3);
  const end = rest.search(/[/?#]/);
  const authority = end < 0 ? rest : rest.slice(0, end);
  const host = authority.slice(authority.lastIndexOf("@") + 1);

  return host.split(":")[0] ?? "";
};

export type FireUrlProblem = { readonly message: string };

export const checkFireUrl = (url: string): FireUrlProblem | null =>
  isFireUrlAllowed(url)
    ? null
    : { message: `fire_url が ${FIRE_URL_PREFIX} で始まっていません` };

export type FireSession = {
  readonly ccSessionId: string;
  readonly ccSessionUrl: string;
};

export type FireOutcome =
  | { readonly ok: true; readonly session: FireSession | null }
  | { readonly ok: false; readonly reason: string };

/**
 * fire トークンを**セッションを作らずに**確かめた結果（要件 `F-H3` の `check`）。
 *
 * **`ok` 以外の 3 つは、読む人が取るべき行動が違う**ので種別で分ける ——
 * `rejected` はトークンの再発行、`routine_not_found` は URL の貼り直し、
 * `unreachable` は時間を置いて再試行。
 */
export type FireTokenVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly kind: "rejected" | "routine_not_found" | "unreachable";
    };

/**
 * 上限を超える `text` を送ったときの状態コードを読む。**この関数が知識の本体。**
 *
 * fire は上限（65,536 字）超えを**認証の後で**弾く。だから故意に長い `text` を
 * 送れば `400` ＝ 認証は通った / `401` ＝ 通っていない と切り分けられて、
 * **どちらでもセッションは作られない**（実行回数を消費しない）——
 * kanata で確立した手で、offdesk は投入の前に必ずこれを通す。
 *
 * **形を見るのではなく実際に叩くのが肝。** `sk-ant-x` のような「それらしい」
 * 置き換え文字列は Zod をすり抜ける（実際にすり抜けて本番へ送られた事故がある）。
 *
 * **判定できないものは通す。** `429` は「アカウントの実行数の上限」で
 * トークンの良し悪しではないし、`5xx` は Anthropic 側の一時的な失敗 ——
 * ここで落とすと、**トークンは正しいのに登録できない**時間帯ができる。
 */
export const fireTokenVerdictOf = (status: number): FireTokenVerdict => {
  if (status === 401 || status === 403) return { ok: false, kind: "rejected" };
  if (status === 404) return { ok: false, kind: "routine_not_found" };
  return { ok: true };
};

/** 届かなかった（ネットワークが落ちた・DNS が引けない）。 */
export const FIRE_TOKEN_UNREACHABLE: FireTokenVerdict = {
  ok: false,
  kind: "unreachable",
};
