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

/**
 * `fire_url` の中の routine 識別子（`/v1/claude_code/routines/<id>/fire` の `<id>`）。
 *
 * **`new URL` を使わない。** このパッケージは `lib: ["ES2022"]` ／ `types: []` で
 * 閉じてあるので `URL` は型として見えない（`hostOf` が同じ理由で手で切っている）。
 *
 * 形が読めなければ `null`。**`null` を「同じ」の根拠にしない**（`sameRoutine`）。
 */
export const ROUTINE_PATH = "/v1/claude_code/routines/";

export const routineIdOf = (url: string): string | null => {
  const at = url.indexOf(ROUTINE_PATH);
  if (at < 0) return null;

  const rest = url.slice(at + ROUTINE_PATH.length);
  const end = rest.search(/[/?#]/);
  const id = end < 0 ? rest : rest.slice(0, end);

  return id === "" ? null : id;
};

/**
 * 2 つの `fire_url` が**同じ routine を指しているか。**
 *
 * トークンは routine ごとに発行される（`fire` のドキュメント:
 * 「The bearer token is scoped to a single routine」）ので、**指す先が変われば
 * いま持っているトークンは必ず通らない。** 画面の注意書きだけに頼ると、
 * 貼り替えたのにトークンを入れ忘れた行が残り、**次に `/offdesk` を叩いた人が
 * 401 を見る**（そのときには誰も編集画面を見ていない）。
 *
 * **識別子が読めないときは URL 全体で比べる。** 読めないことを「同じ」に
 * 倒すと、形が変わった日にこの検査が静かに無効になる。
 */
export const sameRoutine = (a: string, b: string): boolean => {
  const left = routineIdOf(a);
  const right = routineIdOf(b);

  return left !== null && right !== null
    ? left === right
    : a.trim() === b.trim();
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

/**
 * 起動の結果。
 *
 * **失敗には 2 種類ある**（2026-09-16 に分けた）。
 *
 * `fire` には idempotency key が無く、**成功した POST は必ず新しいセッションを
 * 作る**（`Each successful request creates a new session.`）。だから
 * 「応答が返ってこなかった」を `failed` に畳むのは嘘になりうる ——
 * POST は Anthropic 側で成功していて、通信だけが切れたのかもしれない。
 *
 * - `certain: true` … **起動していないと言い切れる**（宛先が不正・トークンが無い・
 *   `4xx`/`5xx` の応答が返った）。台帳を `failed` にしてよい
 * - `certain: false` … **届いたか分からない**（`fetch` が例外を投げた）。
 *   台帳は `queued` のままにする —— 実は動いていた場合、そのセッションが
 *   `ask_human` を呼んだ時点で run は先へ進む（終端に畳んでいると
 *   `closed` を返して止めてしまう）。動いていなければ cron が 10 分後に畳む
 */
export type FireOutcome =
  | { readonly ok: true; readonly session: FireSession | null }
  | {
      readonly ok: false;
      readonly certain: boolean;
      readonly reason: string;
    };

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
