/*
  oRPC を載せるパス。**client・worker・wrangler.jsonc の 3 か所が同じ値を指す。**

  `rpcUrl` を置いてあるのは、**相対パスをそのまま `RPCLink` に渡すと動かない**ため。
  oRPC は内部で `new URL(baseUrl)` を呼ぶので、`"/rpc"` を渡すと
  `TypeError: Invalid URL` になり、**リクエストがブラウザから 1 度も出ない。**
  しかもその例外は「未ログイン」と見分けが付かない形で表に出るので、
  気付くまでに時間がかかる（P1 §9-7 で実際に踏んだ）。
*/

/** Hono のマウント先と `run_worker_first` の一覧が指すパス。 */
export const RPC_PREFIX = "/rpc";

/**
 * `RPCLink` に渡す絶対 URL。
 *
 * `origin` は呼び手が渡す（client なら `window.location.origin`）。
 * **ここで `window` を触らない**——`packages/contract` は client と worker の
 * 両方から import されるので、ブラウザにしか無いものを掴むと worker 側で壊れる。
 *
 * **`URL` も使わない。** この package の tsconfig は `lib: ["ES2022"]` ＋
 * `types: []` で、`URL` は DOM か Node の型に入っている。DOM を足すと
 * `window` や `document` まで契約から見えてしまうので、文字列だけで組む。
 */
export const rpcUrl = (origin: string): string =>
  `${origin.replace(/\/+$/, "")}${RPC_PREFIX}`;
