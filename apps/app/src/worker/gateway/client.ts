import { GatewayStatus } from "@offdesk/contract";
import type { WorkerEnv } from "../env.ts";
import { GATEWAY_PATH, gatewayFetch } from "./gateway.do.ts";

/*
  DO の応答を契約（`GatewayStatus`）に通す 1 か所。

  **叩く口が 2 つある**（`GET /gateway/status` の Bearer と、P7b の運用画面の
  oRPC）。**同じ形を出すことが要件 `F-I7` の要点**なので、parse をどちらの縁にも
  書かずにここへ寄せる —— 分けて書くと、片方だけスキーマを外したときに
  「curl では出ないのに画面には出る値」が生まれる（脅威 15）。

  **`status` を持ち回すのは 429 のため。** DO は連打を 429 で断るので
  （60 秒の間隔。脅威 15）、呼ぶ側がそれを HTTP なり oRPC のエラーなりに
  translate できるよう、状態と一緒に返す。
*/

export type GatewayReply = {
  readonly status: number;
  readonly body: GatewayStatus;
};

const reply = async (upstream: Response): Promise<GatewayReply> => ({
  status: upstream.status,
  /*
    **スキーマに無い値はここで落ちる。** DO 側にデバッグ情報を足したとき、
    bot token に到達する値が外へ出る経路をこの 1 行が塞ぐ。
  */
  body: GatewayStatus.parse(await upstream.json()),
});

export const readGatewayStatus = async (
  env: WorkerEnv,
): Promise<GatewayReply> => reply(await gatewayFetch(env, GATEWAY_PATH.status));

export const resetGateway = async (env: WorkerEnv): Promise<GatewayReply> =>
  reply(await gatewayFetch(env, GATEWAY_PATH.reset, "POST"));

export const ensureGateway = async (env: WorkerEnv): Promise<GatewayReply> =>
  reply(await gatewayFetch(env, GATEWAY_PATH.ensure, "POST"));
