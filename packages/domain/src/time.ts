/*
  **このパッケージは epoch ミリ秒しか扱わない。** JST の整形は
  `@offdesk/contract` の `time.ts` にある（要件 N-5）。

  時刻を「読む」ことは port にする（要件 §10-3 の 4 つの port の 1 つ）。
  ここに `Date.now()` を書くと、待ちの境界（P3a の 15 分・P4 の 60 秒と 6 時間）を
  検査するテストが実時間を待つことになる。**時間で待つテストを書かない**
  （計画 README §2-3）ためには、時計が引数で入ってくる形にしておく必要がある。
*/

/** 時計の port。実装は worker 側のアダプタが入れる。 */
export type Clock = {
  readonly nowMs: () => number;
};

/** 経過ミリ秒。**未来の時刻を渡すと負になる**（呼び手が判断する）。 */
export const elapsedMs = (sinceMs: number, nowMs: number): number =>
  nowMs - sinceMs;

/**
 * `sinceMs` から `windowMs` 以上経ったか。
 *
 * **境界（ちょうど `windowMs`）は「経った」に含める。** 含めないと、
 * ポーリングの間隔と待ちの上限が一致したときに 1 周期ぶん余計に待つ
 * （P3a の握りは上限で自分から降りる必要がある）。
 */
export const hasElapsed = (
  sinceMs: number,
  nowMs: number,
  windowMs: number,
): boolean => elapsedMs(sinceMs, nowMs) >= windowMs;
