import { DurableObject } from "cloudflare:workers";
import type { WorkerEnv } from "../env.ts";

/**
 * Discord Gateway の常駐接続（要件 F-E）。**P0 は空。中身は P4 で入れる。**
 *
 * ここに置いてあるのは「DO を持つ Worker が 1 デプロイに乗るか」（`V-3`）を
 * P0 の時点で確かめるため。空でも Cloudflare 側には namespace が作られ、
 * migrations の tag も本番の preview subdomain の扱いも P4 と同じ条件になる。
 *
 * **常駐 DO を 2 つ以上にしない。** 1 つで約 324,000 GB-s／月を使い、
 * Workers Paid に含まれる 400,000 GB-s を 2 つで超える。
 */
export class DiscordGatewayDO extends DurableObject<WorkerEnv> {
  override fetch(): Response {
    // P4 まではどの経路からも呼ばれない。**黙って 200 を返さない**
    // （繋がっていないのに繋がったように見えるのが最も困る壊れ方）。
    return new Response("Gateway は P4 で実装します", { status: 501 });
  }
}
