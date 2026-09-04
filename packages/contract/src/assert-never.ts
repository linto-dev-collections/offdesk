/**
 * 分岐漏れをコンパイルエラーにする（計画 P7a §3-2）。
 *
 * **`packages/domain` にも同じ 3 行がある。** あちらは副作用も外部ライブラリも
 * 持たない葉のパッケージ（`domain-is-pure`）で、こちらは依存の終着点
 * （`contract-is-terminal`）—— **どちらも相手を import できない**ので、
 * 両側から使う小さな道具はこうして 2 つになる（`FIRE_URL_PREFIX` と同じ理由）。
 *
 * client が `packages/domain` を掴めない（`client-no-server-packages`）ため、
 * 画面側の `switch` が使うのはこちら。
 */
export const assertNever = (value: never): never => {
  throw new Error(`到達しないはずの分岐に来ました: ${JSON.stringify(value)}`);
};
