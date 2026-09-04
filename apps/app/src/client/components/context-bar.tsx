const BAR_MAX_PERCENT = 100;

const asK = (tokens: number): string => `${Math.round(tokens / 1000)}k`;

/**
 * コンテキスト残量（要件 `F-D4`）。Discord に出す 1 行と**同じ読み方**にしてある。
 *
 * **`percent` が `null` なら「—」。** `0%` を出すと「まだ何も使っていない」という
 * 嘘になる（1 度も通報が届いていないだけ）。
 *
 * **バーは満杯で止め、`%` はそのまま出す。** 分母がモデルと合っていないと
 * `203%` が出るが、**それは直すべき事実**なので隠さない。
 */
export const ContextBar = ({
  percent,
  usedTokens,
  windowTokens,
  windowKnown,
}: {
  readonly percent: number | null;
  readonly usedTokens?: number | null;
  readonly windowTokens?: number | undefined;
  readonly windowKnown?: boolean | undefined;
}) => {
  if (percent === null) {
    return (
      <span
        className="text-muted-foreground text-xs"
        title="残量の通報がまだ届いていません"
      >
        —
      </span>
    );
  }

  const filled = Math.min(Math.max(percent, 0), BAR_MAX_PERCENT);
  const tokens =
    usedTokens === null ||
    usedTokens === undefined ||
    windowTokens === undefined
      ? null
      : `${asK(usedTokens)}/${asK(windowTokens)}`;

  return (
    <div className="flex items-center gap-2">
      {/*
        **バーは装飾。** 数字（`42%`）と生のトークン数が隣に出ているので、
        支援技術にはそちらが読まれる方が正確 —— `role="meter"` を置くと
        `<meter>` を使えという指摘になるが、あの要素は見た目を揃えられない。
      */}
      <div
        aria-hidden="true"
        className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted"
      >
        <div
          data-slot="context-bar-fill"
          className="h-full bg-primary"
          style={{ width: `${filled}%` }}
        />
      </div>
      <span className="text-xs tabular-nums">{percent}%</span>
      {tokens === null ? null : (
        <span className="text-muted-foreground text-xs tabular-nums">
          {tokens}
        </span>
      )}
      {windowKnown === false ? (
        <span
          className="text-muted-foreground text-xs"
          title="モデル名から窓を引けていないので、200k を仮の分母にしています"
        >
          （分母は仮）
        </span>
      ) : null}
    </div>
  );
};
