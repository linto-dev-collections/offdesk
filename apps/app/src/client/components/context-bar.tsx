const BAR_MAX_PERCENT = 100;

const asK = (tokens: number): string => `${Math.round(tokens / 1000)}k`;

/**
 * コンテキスト**使用量**（要件 `F-D4`）。Discord に出す 1 行と**同じ読み方**にしてある。
 *
 * **「残量」ではない**（2026-09-06 に直した）。`used / window` なので、`123%` は
 * 「残り 123%」ではなく**分母が間違っている**という合図。
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
  /*
    **省略可にしない**（2026-09-06）。一覧が `percent` だけを渡していたせいで、
    生のトークン数も「窓が引けていません」も出ず、`123%` が裸で出た。
    必須にしておけば、呼ぶ側が渡し忘れた時点で型検査が止める。
  */
  readonly usedTokens: number | null;
  readonly windowTokens: number;
  readonly windowKnown: boolean;
}) => {
  if (usedTokens === null) {
    return (
      <span
        className="text-muted-foreground text-xs"
        title="使用量の通報がまだ届いていません"
      >
        —
      </span>
    );
  }

  // 窓を引けていないなら分子だけ。仮の分母で割った `%` は嘘になる（要件 `F-D4`）。
  if (!windowKnown || percent === null) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs tabular-nums">{asK(usedTokens)}</span>
        <span
          className="text-muted-foreground text-xs"
          title="モデル名から窓を引けていないので、割合は出せません"
        >
          窓が引けていません
        </span>
      </div>
    );
  }

  const filled = Math.min(Math.max(percent, 0), BAR_MAX_PERCENT);
  const tokens = `${asK(usedTokens)}/${asK(windowTokens)}`;

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
      <span className="text-muted-foreground text-xs tabular-nums">
        {tokens}
      </span>
    </div>
  );
};
