import { HookSessionEndInput } from "@offdesk/contract";
import {
  createDb,
  findRun,
  hasEventOfKind,
  isTerminalStatus,
  markRunDone,
} from "@offdesk/db";
import { sessionEndMessage } from "../discord/components.ts";
import { postMessage } from "../discord/rest.ts";
import type { WorkerEnv } from "../env.ts";
import { discordRestConfig } from "../session/launch.ts";

/*
  セッションの終了（要件 `F-D6`・`I-11`・計画 P5 §3-4）。

  **終わるのはここだけ。** `Stop`（1 ターンの終わり）では状態を変えない ——
  kanata はここを間違えて `Stop` で `done` を立てていたため、会話の途中で
  「🏁 セッションが終了しました」が出ていた（同じセッションが 8 回鳴らした記録がある）。

  **`F-C2` の判定と噛み合うともっと悪い。** `done` が立ったスレッドへ次に書くと
  「起こし直し」になるので（P4）、生きている run の隣に 2 本目が立つ。
*/

const NO_CONTENT = 204;

const noContent = (): Response => new Response(null, { status: NO_CONTENT });

export const handleHookSessionEnd = async (
  request: Request,
  env: WorkerEnv,
): Promise<Response> => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noContent();
  }

  const parsed = HookSessionEndInput.safeParse(body);
  if (!parsed.success) {
    console.warn("[hooks] session-end の形が違います");
    return noContent();
  }

  const runKey = parsed.data.run_key;
  const db = createDb(env.DB);

  /*
    **台帳に無い run の通報は無視してよい**（計画 P5 §3-4 の 2）。hook スクリプトは
    転写ログから `OFFDESK-<16hex>` を拾うので、offdesk 以外の用途で同じ
    リポジトリに cloud session を開くと、run の無い通報が来うる。
  */
  const run = await findRun(db, runKey);
  if (run === null) return noContent();

  /*
    **既に終端なら何もしない**（「二重に出さない」の 1 段目）。同じ `SessionEnd` が
    2 回来たときと、`failed` / `abandoned` で畳んだ run に来たときの両方を
    ここで止める。
  */
  if (isTerminalStatus(run.status)) return noContent();

  /*
    **畳めなかったら枠も出さない**（1 段目の取りこぼしを塞ぐ）。上の検査と
    この UPDATE の間に別の経路が畳むことはありうるので、**枠を出すかどうかは
    「自分が畳めたか」で決める。**
  */
  if (!(await markRunDone(db, runKey, Date.now()))) return noContent();

  /*
    **`report(done)` が先に来ていたら枠を出さない**（「二重に出さない」の 2 段目）。
    あちらも 🏁 の枠なので、両方出すと同じ合図が 2 回並ぶ。
  */
  if (await hasEventOfKind(db, runKey, "done")) return noContent();

  /*
    **スレッドが無い run には出さない**（要件 `F-A7`）。親チャンネルへ出すと、
    そのチャンネルの雑談の中に終了の枠だけが落ちる。
  */
  if (run.threadId === null) return noContent();

  const posted = await postMessage(
    discordRestConfig(env),
    run.threadId,
    sessionEndMessage(),
  );
  if (!posted.ok) {
    // **台帳は畳んである。** 出せなかったことだけを残す（要件 `N-7`）。
    console.warn("[hooks] 終了の枠を Discord へ出せませんでした", {
      runKey,
      reason: posted.reason,
    });
  }

  return noContent();
};
