export const CONTEXT_BAR_WIDTH = 20;

const BAR_FILLED = "▓";
const BAR_EMPTY = "░";

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

const CONTEXT_WINDOW_1M = 1_000_000;

/*
  モデル → **Claude Code における既定の**窓（2026-09-06 の公式一覧で引き直した）。

  **環境変数でも `projects` の列でもなくコードに置く**（要件 `F-D4`）。
  レビューに乗るし、routine のモデルを変えても保存してあるモデル名から引き直すので
  自動で追従する。**モデルを足すときはここ 1 か所。**

  鍵は転写ログの `.message.model` がそのまま入る形にしてある（別名と日付つきの
  両方を並べてあるのはそのため。どちらが来るかは Claude Code 側の都合）。

  **「モデルの最大窓」ではなく「Claude Code の既定の窓」を入れる**（2026-09-06 に
  直した。初版は Opus 5 に 1M を入れていた）。API では 1M でも、Claude Code の
  既定は 200K で、1M は `[1m]` の変種を選んだときだけ開くモデルがある ——
  素の `claude-opus-5` に 1M を入れると、**実使用 60% が「12%」に見える。**
  要件 `F-D4` が「多い側に倒すと気づけない」と書いている壊れ方そのもの。

  3 つに分かれる:

    native 1M   … 変種を付けなくても 1M（Fable / Mythos / Sonnet 5）
    既定 200K   … 1M は `[1m]` でだけ開く（Opus 5 / 4.8 / 4.7 / 4.6・Sonnet 4.6）
    1M 無し     … Haiku
*/
const MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  "claude-fable-5-1": CONTEXT_WINDOW_1M,
  "claude-fable-5": CONTEXT_WINDOW_1M,
  "claude-mythos-5-1": CONTEXT_WINDOW_1M,
  "claude-mythos-5": CONTEXT_WINDOW_1M,
  "claude-sonnet-5": CONTEXT_WINDOW_1M,
  "claude-opus-5": DEFAULT_CONTEXT_WINDOW_TOKENS,
  "claude-opus-4-8": DEFAULT_CONTEXT_WINDOW_TOKENS,
  "claude-opus-4-7": DEFAULT_CONTEXT_WINDOW_TOKENS,
  "claude-opus-4-6": DEFAULT_CONTEXT_WINDOW_TOKENS,
  "claude-sonnet-4-6": DEFAULT_CONTEXT_WINDOW_TOKENS,
  "claude-haiku-4-5": DEFAULT_CONTEXT_WINDOW_TOKENS,
  "claude-haiku-4-5-20251001": DEFAULT_CONTEXT_WINDOW_TOKENS,
};

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

export const hasKnownContextWindow = (model: string | null): boolean =>
  model !== null && splitModelVariant(model).name in MODEL_CONTEXT_WINDOWS;

export const contextWindowFor = (model: string | null): number => {
  if (model === null) return DEFAULT_CONTEXT_WINDOW_TOKENS;

  const { name, variant } = splitModelVariant(model);
  const base = MODEL_CONTEXT_WINDOWS[name];
  if (base === undefined) return DEFAULT_CONTEXT_WINDOW_TOKENS;

  return variant === LONG_CONTEXT_VARIANT ? CONTEXT_WINDOW_1M : base;
};

export type ContextUsage = Readonly<{
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}>;

export const contextUsedTokens = (usage: ContextUsage): number =>
  usage.inputTokens +
  usage.cacheCreationInputTokens +
  usage.cacheReadInputTokens;

const asK = (tokens: number): string => `${Math.round(tokens / 1000)}k`;

export const contextLine = (input: {
  readonly usedTokens: number | null;
  readonly windowTokens: number;
}): string | null => {
  const { usedTokens, windowTokens } = input;
  if (usedTokens === null || windowTokens <= 0) return null;

  const used = Math.max(usedTokens, 0);
  const ratio = used / windowTokens;

  const filled = Math.min(
    Math.floor(ratio * CONTEXT_BAR_WIDTH),
    CONTEXT_BAR_WIDTH,
  );
  const bar =
    BAR_FILLED.repeat(filled) + BAR_EMPTY.repeat(CONTEXT_BAR_WIDTH - filled);

  return `-# ${bar} ${Math.round(ratio * 100)}% ・${asK(used)}/${asK(windowTokens)}`;
};
