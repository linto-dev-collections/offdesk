/**
 * 外へ出る `fetch`。**必ずこれを渡す。**
 *
 * **`{ fetch }` と裸のグローバルを持たせてはいけない。** プロパティ経由で
 * `config.fetch(...)` と呼ぶと `this` がそのオブジェクトになり、workerd が
 * `TypeError: Illegal invocation: function called with incorrect \`this\` reference`
 * を投げる（2026-09-04 に本番で踏んだ。P2 §9-9）。
 *
 * **テストの替え玉では再現しない** —— `vi.stubGlobal("fetch", fn)` が差す素の関数は
 * `this` を見ないので、本物より寛容になる。だから包む側を 1 か所に閉じ、
 * そこを `outbound.test.ts` が実物の workerd で叩く。
 */
export const outboundFetch: typeof fetch = (input, init) => fetch(input, init);
