import { oc } from "@orpc/contract";
import { DashboardOutput } from "./dashboard.ts";
import { GatewayStatus } from "./gateway.ts";
import { MeOutput } from "./me.ts";
import { PlanListOutput, PlanRemoveInput, PlanRemoveOutput } from "./plan.ts";
import { ProjectListOutput } from "./project.ts";
import {
  RunDetailInput,
  RunDetailOutput,
  RunListOutput,
  RunListQuery,
} from "./run.ts";

/**
 * oRPC の契約。**サーバー実装から独立している**（要件 I-8）。
 *
 * **`.output()` を必ず付ける。** 出力検証が生きていれば、正規化漏れが
 * 「画面がおかしい」ではなく「その手続きが出力検証で落ちる」形で表面化する。
 */
export const contract = {
  me: oc.output(MeOutput),
  dashboard: {
    summary: oc.output(DashboardOutput),
  },
  gateway: {
    status: oc.output(GatewayStatus),
    /*
      **状態を変える 2 つのうちの 1 つ**（もう 1 つは `plans.remove`。要件 `F-F4`）。

      **429 を型で持つ**（脅威 15 の「60 秒に 1 回」）。`data` に状態を載せて
      あるので、断られた画面はそのまま残り時間を出せる ——
      載せないと、断られた直後に `status` をもう 1 回叩くことになる。
    */
    reset: oc
      .errors({ TOO_MANY_REQUESTS: { data: GatewayStatus } })
      .output(GatewayStatus),
  },
  plans: {
    list: oc.output(PlanListOutput),
    remove: oc.input(PlanRemoveInput).output(PlanRemoveOutput),
  },
  projects: {
    list: oc.output(ProjectListOutput),
  },
  runs: {
    /*
      **入力は URL の search params と同じスキーマ**（計画 P7a §3-4）。
      2 本に分けると「URL の検証だけ緩い」状態が作れる。
    */
    list: oc.input(RunListQuery).output(RunListOutput),
    detail: oc.input(RunDetailInput).output(RunDetailOutput),
  },
};
