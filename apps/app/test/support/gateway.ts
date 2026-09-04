import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";

/*
  Gateway の DO をテストの前に空へ戻す。

  **`vitest.setup.ts` の `clearD1` では戻らない。** あれは D1 の表を消すだけで、
  DO は**メモリの状態**（`#state` / `#socket`）と**DO storage**（`fatalReason` /
  `resetAt`）を別に持っている。ストレージの分離は**ファイル単位**なので、
  戻さないと同じファイル内でテストの順序に依存する ——
  実測（2026-09-04）: `reset` を叩くテストの後に `ensure` のテストが走ると、
  DO は `backoff` の途中なので**繋ぎに行かず**、替え玉が 1 回も呼ばれない
  （「替え玉が DO まで届いていない」と読み違える形）。

  **2 手が要る。** `deleteAll` で永続分を消し、`evict` でメモリ分を捨てる ——
  `fatal` はコンストラクタで storage から読み直すので、順序を逆にすると
  読み直した後に消すことになって残る。

  ## ソケットが開いていると使えない（2026-09-04 に実測）

  **`evictDurableObject` は、DO が outbound WebSocket を握っている間は返ってこない。**
  outbound WebSocket は hibernation 非対応なので（Cloudflare のドキュメント）、
  evict の「実行中の要求が抜けるのを待つ」が永久に満たされない。
  `{ webSockets: "close" }` を渡しても変わらない —— あれは DO が**サーバー側**で
  受けた（hibernation 可能な）ソケットの話。

  **症状は「テストが黙って固まる」**（vitest の `hookTimeout` は 10 秒で落ちるが、
  それ以外の出力が何も出ないので原因が見えない）。だから:

    - ソケットを張るテストは**ファイルごとに 1 本の流れ**で書く（ストレージの分離が
      ファイル単位なので、ファイルの頭で 1 回だけ戻せばよい）
    - テストの合間に戻したいときは、**先にソケットを閉じさせる**
      （相手側から `close` を送る、または `fatal` に落とす）
*/

const stubOf = () => env.GATEWAY.get(env.GATEWAY.idFromName("main"));

export const resetGatewayDO = async (): Promise<void> => {
  const stub = stubOf();

  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.deleteAll();
  });

  // `evictDurableObject` は走っていない DO を渡すと reject する。
  // 直前の `runInDurableObject` が起こしてあるので、ここでは必ず走っている。
  await evictDurableObject(stub);
};

/** メモリの状態だけを捨てる（永続分は残す）。`fatal` が evict を越えることの検査用。 */
export const evictGatewayDO = async (): Promise<void> => {
  await evictDurableObject(stubOf());
};
