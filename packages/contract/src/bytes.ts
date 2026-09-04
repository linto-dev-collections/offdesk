const KIB = 1024;

const UNITS = ["B", "KB", "MB", "GB"] as const;

/**
 * 計画の合計サイズ（計画 P7b §3-1）。
 *
 * **1024 で刻んで単位は KB / MB と書く。** 厳密には KiB / MiB だが、
 * 上限を伝える文（`publish-plan.sh` の「1MB まで」「8MB まで」）が
 * 同じ意味で MB と書いているので、**画面と口で数字が食い違わない方を採る。**
 *
 * **`Intl.NumberFormat` を使わない。** 桁区切りだけが要る場所で
 * ロケールに依存する関数を入れると、環境によって出る文字が変わる
 * （テストが動く場所と本番で違う結果になる）。
 */
export const formatBytes = (bytes: number): string => {
  const safe = Math.max(Math.trunc(bytes), 0);
  if (safe < KIB) return `${safe} B`;

  let value = safe;
  let unit = 0;
  while (value >= KIB && unit < UNITS.length - 1) {
    value /= KIB;
    unit += 1;
  }

  /** 1 桁だけ残す。**整数に丸めると 1.4MB と 1.5MB の差が消える。** */
  const rounded = Math.round(value * 10) / 10;
  return `${rounded} ${UNITS[unit]}`;
};
