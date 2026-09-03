import { DurableObject } from "cloudflare:workers";
import type { WorkerEnv } from "../env.ts";

export class DiscordGatewayDO extends DurableObject<WorkerEnv> {
  override fetch(): Response {
    return new Response("Gateway は P4 で実装します", { status: 501 });
  }
}
