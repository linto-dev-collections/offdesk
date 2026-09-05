import type { WorkerEnv } from "../env.ts";
import { ensureGateway } from "../gateway/client.ts";

/*
  Gateway の DO を起こす watchdog（要件 `F-I2`・計画 P8 §3-3）。

  **DO は自分では起動できない。** alarm ごと evict された状態から戻す手が
  これしかない —— outbound WebSocket は hibernation 非対応なので、
  15 分を過ぎた接続は通常の evict 規則に戻り、そこでタイマも消える。

  **張るかどうかを決めるのは DO 側**（`step`）。`idle` と期限切れの `backoff` なら
  張り、`live` なら何もせず、**`fatal` なら何もしない**（要件 `F-I4`）——
  ここに判定を持ち込むと、同じ規則が 2 か所に散る。
*/

export const ensureGatewayConnected = async (env: WorkerEnv): Promise<void> => {
  const { body } = await ensureGateway(env);

  /*
    **`fatal` は `error` で出す。** 人が直すまで戻らない状態で、
    cron は 5 分ごとに空振りし続ける —— ここが `warn` だと、
    「静かに素の文を拾えないまま」が延々と続く（要件 `N-7`）。
    **理由は鍵だけ**（`close_4014` の形）で、bot token に到達する値は無い（脅威 15）。
  */
  if (body.state === "fatal") {
    console.error("[cron] Gateway が fatal です（人が直すまで戻りません）", {
      reason: body.fatalReason,
    });
    return;
  }

  /*
    **繋がっているときは黙る。** 5 分ごとに出すと、ログが「正常」で埋まって
    異常が埋もれる。出すのは「起こしに行ったが、まだ健全ではない」ときだけ。
  */
  if (!body.healthy) {
    console.warn("[cron] Gateway がまだ健全ではありません", {
      state: body.state,
      connected: body.connected,
    });
  }
};
