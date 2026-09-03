/**
 * D1 が BLOB を返す形は driver と版で揺れる（`ArrayBuffer` / `Uint8Array` /
 * 素の number 配列）。**読み出しの境界で 1 度だけ均す。**
 * ここが無いと「ローカルでは復号できるのに本番で認証タグが合わない」が起きうる。
 */
export const toBytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return new Uint8Array(value);
  throw new Error("BLOB をバイト列として読めませんでした");
};
