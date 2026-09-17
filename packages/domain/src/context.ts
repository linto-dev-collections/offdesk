export const CONTEXT_BAR_WIDTH = 20;

const BAR_FILLED = "▓";
const BAR_EMPTY = "░";

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

const CONTEXT_WINDOW_1M = 1_000_000;

/*
  routine のフォームにはモデルセレクタがあるので、ここに無いモデルを選ばれると Discord のバーが「窓が引けていません」に化ける。
  表に足す条件は「この契約で何 token になるかが一意に決まること」（`context.test.ts` の「確信の無いモデルは表に足さない」）—— 迷うものは足さず、`%` を出さない側へ倒す。

  **正本は Claude Code が抱えているモデル表**（`context:{window, native_1m, supports_1m_suffix}`）。
  **platform.claude.com の API docs ではない。** 2026-09-17 に 2.1.274 のバンドルで実測して、両者が食い違うことを確かめた ——
  docs は Opus 4.6 / Sonnet 4.6 を「既定 1M・beta ヘッダ不要」と書くが、**Claude Code はどちらも `window:200000` で回し、1M は `[1m]` 変種で選ばせる。**

  **ここで要るのは「API の最大」ではなく「この run が実際に走っている窓」。**
  バーが答えるのは「あと何割で詰まるか」で、詰まる位置を決めているのは Claude Code の側（自動 compact もそこで動く）。
  API の 1M を分母にすると、200K で走っているセッションを「まだ 6%」と 5 倍甘く表示して、**警告として役に立たなくなる。**

  表に足す条件は「Claude Code のモデル表で `native_1m` が立っていること」。
  `native_1m` が無いものは `window` の値（200K）で足し、`[1m]` が付いていれば `splitModelVariant` が 1M に上書きする。

  更新手順は OPERATIONS.md §12（バンドルから 1 行で引ける）。
*/
const MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  "claude-fable-5-1": CONTEXT_WINDOW_1M,
  "claude-fable-5": CONTEXT_WINDOW_1M,
  "claude-mythos-5-1": CONTEXT_WINDOW_1M,
  "claude-mythos-5": CONTEXT_WINDOW_1M,
  "claude-sonnet-5": CONTEXT_WINDOW_1M,
  "claude-opus-5": CONTEXT_WINDOW_1M,
  "claude-opus-4-8": CONTEXT_WINDOW_1M,
  "claude-opus-4-7": CONTEXT_WINDOW_1M,
  "claude-sonnet-4-6": DEFAULT_CONTEXT_WINDOW_TOKENS,
  "claude-opus-4-6": DEFAULT_CONTEXT_WINDOW_TOKENS,
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
  readonly windowKnown: boolean;
}): string | null => {
  const { usedTokens, windowTokens, windowKnown } = input;
  if (usedTokens === null || windowTokens <= 0) return null;

  const used = Math.max(usedTokens, 0);

  if (!windowKnown) return `-# ${asK(used)} 使用（窓が引けていません）`;

  const ratio = used / windowTokens;

  const filled = Math.min(
    Math.floor(ratio * CONTEXT_BAR_WIDTH),
    CONTEXT_BAR_WIDTH,
  );
  const bar =
    BAR_FILLED.repeat(filled) + BAR_EMPTY.repeat(CONTEXT_BAR_WIDTH - filled);

  return `-# ${bar} ${Math.round(ratio * 100)}% ・${asK(used)}/${asK(windowTokens)}`;
};
