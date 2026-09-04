import { oc } from "@orpc/contract";
import { DashboardOutput } from "./dashboard.ts";
import { MeOutput } from "./me.ts";
import { PlanRemoveInput, PlanRemoveOutput } from "./plan.ts";
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
  plans: {
    /*
      **取り消しだけを口にする**（要件 `F-E9`）。一覧は P7b で足す ——
      いま作ると、画面の要る形が決まる前に出力の形を固めることになる。
    */
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
