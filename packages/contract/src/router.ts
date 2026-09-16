import { oc } from "@orpc/contract";
import { DashboardOutput } from "./dashboard.ts";
import { GatewayStatus } from "./gateway.ts";
import { MeOutput } from "./me.ts";
import { PlanListOutput, PlanRemoveInput, PlanRemoveOutput } from "./plan.ts";
import { ProjectListOutput } from "./project.ts";
import {
  FireTokenProblem,
  ProjectChannelsOutput,
  ProjectCommandsOutput,
  ProjectConflict,
  ProjectCreateInput,
  ProjectDisableInput,
  ProjectUpdateInput,
  ProjectWriteOutput,
  RoutinePromptOutput,
} from "./project-write.ts";
import {
  RunDetailInput,
  RunDetailOutput,
  RunListOutput,
  RunListQuery,
} from "./run.ts";

/**
 * 台帳を書く 3 本が**同じエラーの集合を宣言する。**
 *
 * **口ごとに削らない。** 失敗の形（`WriteProjectProblem`）は 3 本で共通なので、
 * 宣言だけを絞ると**写し替えの関数が 3 つに増える** —— 増えた側がいつか食い違う。
 * 起こらない組み合わせ（`setDisabled` の `CONFLICT` など）はクライアントに
 * 届かないだけで害が無い。
 *
 * - `CONFLICT` … 名前とチャンネルの一意（要件 `F-H4`）。**どちらが埋まっているか**を返す
 * - `UNPROCESSABLE_CONTENT` … トークンを実際に叩いて弾かれた（種別だけ。脅威 12）
 * - `SERVICE_UNAVAILABLE` … `FIRE_TOKEN_KEY` が未設定（要件 `F-H2`。暗号化できない）
 */
const PROJECT_WRITE_ERRORS = {
  NOT_FOUND: {},
  CONFLICT: { data: ProjectConflict },
  UNPROCESSABLE_CONTENT: { data: FireTokenProblem },
  SERVICE_UNAVAILABLE: {},
} as const;

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
  /*
    プロジェクトの台帳（要件 `F-H1`〜`F-H5`）。

    **`projects.json` と CLI を畳んでここへ移した**（2026-09-16）。要件 §3-2 は
    画面からの CRUD を第2フェーズに置いたうえで「**正本が D1 になっていれば、
    画面は後から足しても移行が起きない**」と書いていて、実際に移行は 1 件も無い。

    消えたのは経路 3 本 —— 手元の `projects.json`・GitHub secret の
    `PROJECTS_JSON`・`projects sync` の workflow。**fire トークンの平文が
    D1 の外に存在しなくなる。**

    **`delete` は無い。** `runs.project_id` が `RESTRICT` の外部キーなので、
    run が 1 本でもあるプロジェクトは構造的に消せない —— 止めたいときは
    `setDisabled`（要件 `F-H5`）。
  */
  projects: {
    list: oc.output(ProjectListOutput),
    /*
      **2 つとも「実際に叩いて確かめてから」書く**（`UNPROCESSABLE_CONTENT`）。
      CLI の `check` が持っていた性質で、形だけ合っている置き換え文字列
      （`sk-ant-x` のような）が Zod を抜けて本番へ入った事故がある。

      `CONFLICT` は名前とチャンネルの一意（要件 `F-H4`）。**どちらが埋まって
      いるかを返す** —— 画面がその欄に印を付けられる。
    */
    create: oc
      .errors(PROJECT_WRITE_ERRORS)
      .input(ProjectCreateInput)
      .output(ProjectWriteOutput),
    update: oc
      .errors(PROJECT_WRITE_ERRORS)
      .input(ProjectUpdateInput)
      .output(ProjectWriteOutput),
    setDisabled: oc
      .errors(PROJECT_WRITE_ERRORS)
      .input(ProjectDisableInput)
      .output(ProjectWriteOutput),
    /*
      **`/offdesk` の選択肢を登録し直す。** 台帳を変える 3 本が終わりに自分で
      呼ぶので、ここは**ずれたときに人が押す口**（OPERATIONS §2 の `commands`）。
    */
    syncCommands: oc
      .errors({ BAD_GATEWAY: {}, SERVICE_UNAVAILABLE: {} })
      .output(ProjectCommandsOutput),
    channels: oc.output(ProjectChannelsOutput),
    routinePrompt: oc.output(RoutinePromptOutput),
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
