export const CONTEXT_BAR_WIDTH = 20;

const BAR_FILLED = "▓";
const BAR_EMPTY = "░";

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

const CONTEXT_WINDOW_1M = 1_000_000;

/*
  routine のフォームにはモデルセレクタがあるので、ここに無いモデルを選ばれると Discord のバーが「窓が引けていません」に化ける。
  表に足す条件は「この契約で何 token になるかが一意に決まること」（`context.test.ts` の「確信の無いモデルは表に足さない」）—— 迷うものは足さず、`%` を出さない側へ倒す。

  1M の根拠は 2 つあり、**どちらか片方でも足りない**:

  - **API の既定**: Fable 5/5.1・Mythos 5/5.1・Sonnet 5・Opus 4.7 以降は既定で 1M（`claude-opus-5` は 2026-09-06 に cloud session で実測）
  - **サブスクの自動繰り上げ**: Max / Team / Enterprise では **Opus が無設定で 1M に上がる**

  `claude-sonnet-4-6` を 1M で足さない。
  あれは自動繰り上げの対象外で、1M には usage credits が要る —— 既定は 200K なので、そちらで足す（`[1m]` が付いていれば `splitModelVariant` が 1M に上書きする）。

  `claude-opus-4-6` は足さない。
  API の既定は 200K で、1M になるかはプラン次第（Opus 4.7 以降と違って「既定で 1M」の側に居ない）—— 契約が変わると静かにずれるので、表に入れずに「引けません」と言わせる。
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
