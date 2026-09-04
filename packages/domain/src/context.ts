/*
  コンテキスト残量の 1 行（要件 `F-D4`・計画 P5 §3-5）。

  **Claude Code は使用量を外へ出さない。** どの hook の入力にもトークン数は無く、
  ステータスラインは対話 UI 専用でクラウドセッションでは動かない。唯一の出口が
  転写ログの `.message.usage` なので、hook がそれを読んで通報し、ここが描く。
*/

/** バーの幅。**20 文字**（Discord のモバイル幅で折り返さない上限として選んだ）。 */
export const CONTEXT_BAR_WIDTH = 20;

const BAR_FILLED = "▓";
const BAR_EMPTY = "░";

/**
 * 知らないモデルのときの窓（要件 `F-D4`）。
 *
 * **多い側ではなく少ない側に倒す。** 200,000 で 1M のモデルを測ると「500%」に
 * なって**目に付く**が、逆に倒すと「まだ 12%」に見えて**気づけない** ——
 * 気づけない方が高くつく（`console.warn` も入口に出る）。
 */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

const CONTEXT_WINDOW_1M = 1_000_000;

/*
  モデル → 窓（2026-09-04 の公式一覧で確認）。

  **環境変数でも `projects` の列でもなくコードに置く**（要件 `F-D4`）。
  レビューに乗るし、routine のモデルを変えても保存してあるモデル名から引き直すので
  自動で追従する。**モデルを足すときはここ 1 か所。**

  鍵は転写ログの `.message.model` がそのまま入る形にしてある（別名と日付つきの
  両方を並べてあるのはそのため。どちらが来るかは Claude Code 側の都合）。
*/
const MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  "claude-fable-5-1": CONTEXT_WINDOW_1M,
  "claude-opus-5": CONTEXT_WINDOW_1M,
  "claude-sonnet-5": CONTEXT_WINDOW_1M,
  "claude-haiku-4-5": DEFAULT_CONTEXT_WINDOW_TOKENS,
  "claude-haiku-4-5-20251001": DEFAULT_CONTEXT_WINDOW_TOKENS,
};

/**
 * Claude Code は長い窓を `claude-opus-5[1m]` のように**角括弧の変種**で表す。
 * 素の表引きだと当たらないので、外して名前と変種に分ける。
 */
const LONG_CONTEXT_VARIANT = "1m";

const splitModelVariant = (
  model: string,
): { readonly name: string; readonly variant: string | null } => {
  const open = model.indexOf("[");
  if (open < 0 || !model.endsWith("]")) return { name: model, variant: null };

  return {
    name: model.slice(0, open),
    variant: model.slice(open + 1, -1).toLowerCase(),
  };
};

/**
 * その通報に載っていたモデルの窓が分かるか。
 *
 * **`contextWindowFor` と分けてある理由は `console` が無いこと。**
 * `packages/domain` は `types: []` なので、ここでは警告を出せない。
 * 「黙って既定値に倒さない」（要件 `F-D4`）は**入口の `/hooks/context` が
 * これを見て `console.warn` に残す**ことで守る —— 描くたびに鳴らすのではなく、
 * モデル名が入ってきた 1 回だけ鳴る。
 */
export const hasKnownContextWindow = (model: string | null): boolean =>
  model !== null && splitModelVariant(model).name in MODEL_CONTEXT_WINDOWS;

export const contextWindowFor = (model: string | null): number => {
  if (model === null) return DEFAULT_CONTEXT_WINDOW_TOKENS;

  const { name, variant } = splitModelVariant(model);
  const base = MODEL_CONTEXT_WINDOWS[name];
  if (base === undefined) return DEFAULT_CONTEXT_WINDOW_TOKENS;

  /*
    **変種が効くのは名前が分かっているときだけ。** 「`[1m]` が付いていれば 1M」に
    すると、`[1m]` だけの壊れた値や**まだ表に無いモデル**が多い側へ倒れる ——
    多い側は「まだ 12%」に見えて気づけないので、既定値と同じ理由で採らない。
  */
  return variant === LONG_CONTEXT_VARIANT ? CONTEXT_WINDOW_1M : base;
};

/**
 * 転写ログの `.message.usage` から分子に要るものだけを抜いた形。
 *
 * **`output_tokens` を持たない。** 参考値として台帳には残すが、分子には
 * 入らないので（要件 `F-D4`）、**この型に入れると足せてしまう。**
 */
export type ContextUsage = Readonly<{
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}>;

/**
 * 分子。**公式のステータスラインと同じ式**（要件 `F-D4`）。
 *
 * **`output_tokens` を足さない。** 出力は次のターンの入力として
 * `input_tokens` に現れるので、足すと二重に数える。
 * 逆に `cache_read_input_tokens` を落とすと、キャッシュを多用した
 * セッションが「まだ 5%」に見える（P5 §7 の落とし穴）。
 */
export const contextUsedTokens = (usage: ContextUsage): number =>
  usage.inputTokens +
  usage.cacheCreationInputTokens +
  usage.cacheReadInputTokens;

const asK = (tokens: number): string => `${Math.round(tokens / 1000)}k`;

/**
 * 残量の 1 行。**Claude の発言の末尾**に `-#`（subtext）で付ける。
 *
 * 出す場所をここに決めた理由（要件 `F-D4`）:
 *   - スレッド名は Discord の「2 回 / 10 分」の制限で毎ターン更新できない
 *   - スレッド先頭の起動メッセージは、見るのに上までスクロールが要る
 *   - 別メッセージだと会話が bot の相槌で埋まる
 *
 * **次に何を言うか決めるまさにその場**にあるので、見に行く必要がない。
 *
 * **1 度も通報が来ていなければ 1 行も出さない**（`usedTokens` が `null`）——
 * `0%` を出すと「まだ何も使っていない」という嘘になる。
 */
export const contextLine = (input: {
  readonly usedTokens: number | null;
  readonly windowTokens: number;
}): string | null => {
  const { usedTokens, windowTokens } = input;
  if (usedTokens === null || windowTokens <= 0) return null;

  const used = Math.max(usedTokens, 0);
  const ratio = used / windowTokens;

  /*
    **バーは満杯で止め、% はそのまま出す**（要件 `F-D4`）。分母がモデルと
    合っていないと `203%` が出るが、**それは直すべき事実**なので隠さない。
    生のトークン数を併記してあるので真値は見失わない。

    `floor` を使うのは「満杯 ＝ 使い切った」を守るため（`round` だと 99% で
    満杯に見える）。
  */
  const filled = Math.min(
    Math.floor(ratio * CONTEXT_BAR_WIDTH),
    CONTEXT_BAR_WIDTH,
  );
  const bar =
    BAR_FILLED.repeat(filled) + BAR_EMPTY.repeat(CONTEXT_BAR_WIDTH - filled);

  return `-# ${bar} ${Math.round(ratio * 100)}% ・${asK(used)}/${asK(windowTokens)}`;
};
