import {
  abandonAndStart,
  answerAskByMessage,
  createDb,
  type Db,
  findAsk,
  findAskByAnswerMessage,
  findLatestUndeliveredAsk,
  findProjectById,
  findRunByThread,
  fireRoutine,
  isTerminalStatus,
  markQueuedTaken,
  markRunFailed,
  markRunResumed,
  markRunRunning,
  peekQueuedInThread,
  queueMessage,
  type RunRecord,
  takeFireToken,
} from "@offdesk/db";
import {
  buildFireText,
  decideInbound,
  foldInboundLines,
  type InboundDecision,
  type InboundMessage,
  isOwner,
  newRunKey,
  resolveInboundWindows,
} from "@offdesk/domain";
import type { WorkerEnv } from "../env.ts";
import { outboundFetch } from "../outbound.ts";
import { discordRestConfig } from "../session/launch.ts";
import { askAnsweredMessage, noticeMessage } from "./components.ts";
import { markHandedOff, markSeen } from "./marks.ts";
import { editMessage, postMessage } from "./rest.ts";

/*
  スレッドに素で書いた文を Claude への発言にする（要件 `F-C1`〜`F-C6`・計画 P4 §3-5）。

  **判定は `decideInbound`（純粋関数）が持つ。** ここがやるのは、その判定に要る
  ものを D1 から集めて、決まった扱いを台帳と Discord に反映することだけ ——
  4 通りの分岐そのものを DO にも Gateway にも書かない（テストできなくなる）。

  **DO からも呼ばれる。** だから `env` を受けて自分で D1 と Discord を組む。

  **本文をログに出さない**（脅威 12）。出すのは `message_id` と判定結果だけ。
*/

/** 何が起きたか。**DO のログとテストが読む**（本文は含めない）。 */
export type InboundOutcome = Readonly<{
  decision: InboundDecision["kind"] | "duplicate";
  runKey: string | null;
}>;

const ignored = (): InboundOutcome => ({ decision: "ignore", runKey: null });

/** 問いと報告を出す先。**スレッドが無ければ親チャンネル**（要件 `F-A7`）。 */
const threadOf = (run: RunRecord): string => run.threadId ?? run.channelId;

export const applyInbound = async (
  env: WorkerEnv,
  message: InboundMessage,
): Promise<InboundOutcome> => {
  /*
    plans/security.md 脅威 14。**bot 自身の発言を必ず落とす** ——
    落とさないと自分の `report` が自分の入力になって無限ループになる。
    `isOwner` でも落ちるが（bot の id は持ち主の id ではない）、
    **理由が違うものを 1 つの判定にまとめない。**
  */
  if (message.authorIsBot) return ignored();

  /*
    **素の文にも持ち主判定**（脅威 14）。interaction 経路と同じ
    `packages/domain/src/owner.ts` の 1 関数を通す。
    **何も出さない** —— 他の人の雑談に bot が反応して回るのを避ける
    （interaction は ephemeral で本人にだけ返せるが、素の文にその手段が無い）。
  */
  if (!isOwner(env.OWNER_DISCORD_USER_ID, message.authorId)) return ignored();

  const body = message.content.trim();
  // 添付だけ・スタンプだけの発言。`inbox_body_ck` が空を禁じているので手前で落とす。
  if (body === "") return ignored();

  const db = createDb(env.DB);

  /*
    **親チャンネルの発言は拾わない**（要件 `F-C3`）。`runs.thread_id` を引くので、
    親チャンネル id では当たらない —— 要件 `I-4` が「スレッドを作れなかった run の
    `thread_id` は NULL」と定めているのがここを成り立たせている
    （チャンネル id を入れていたら、そのチャンネルの雑談が丸ごと Claude へ流れる）。
  */
  const run = await findRunByThread(db, message.channelId);
  if (run === null) return ignored();

  /*
    **同じメッセージを 2 回扱わない。** Gateway は再接続時にイベントを再送しうる
    （resume の仕様）。溜める側は `inbox_message_uidx` が止めるが、
    **回答として使った文は `inbox` に入らない**ので、こちらは台帳を引いて確かめる。
  */
  const answered = await findAskByAnswerMessage(db, message.messageId);
  if (answered !== null) {
    return { decision: "duplicate", runKey: run.runKey };
  }

  const latest = await findLatestUndeliveredAsk(db, run.runKey);
  // **未回答のものだけが `answer` の対象**（計画 P4 §3-4）。
  const pendingAsk =
    latest !== null && latest.answer === null ? { askId: latest.askId } : null;

  const decision = decideInbound({
    run: {
      terminal: isTerminalStatus(run.status),
      heldAt: run.heldAt,
      activityAt: run.activityAt,
      createdAt: run.createdAt,
    },
    pendingAsk,
    now: Date.now(),
    windows: resolveInboundWindows(env),
  });

  switch (decision.kind) {
    case "ignore":
      return ignored();
    case "answer":
      return await applyAnswer(env, db, run, message, body, decision.askId);
    case "queue":
      return await applyQueue(env, db, run, message, body);
    case "restart":
      return await applyRestart(env, db, run, message, body);
  }
};

/* ---- 4-a. 待っている質問への回答 ---- */

/**
 * **`answer_message_id` を入れるのが要点。** ✅ に付け替える相手が誰かは
 * この 1 列だけが知っている（要件 `I-3`）—— 印を変えるのは
 * `delivered_at` を立てる側（握り）で、そこには元メッセージの情報が無い。
 *
 * **ここで ✅ にしない。** 台帳に答えが入っただけで、Claude へ渡ったわけではない。
 * 渡るのは握っている `ask_human` の戻り値で、そのときに ✅ になる（要件 `F-C4`）。
 */
const applyAnswer = async (
  env: WorkerEnv,
  db: Db,
  run: RunRecord,
  message: InboundMessage,
  body: string,
  askId: string,
): Promise<InboundOutcome> => {
  const written = await answerAskByMessage(
    db,
    askId,
    {
      answer: body,
      discordUserId: message.authorId,
      answerMessageId: message.messageId,
    },
    Date.now(),
  );

  /*
    **負けたら溜める側へ倒す**（要件 `F-C6`）。ほぼ同時にボタンが押されていた
    場合がこれ —— 捨てると書いた文がどこにも残らない。
  */
  if (!written) return await applyQueue(env, db, run, message, body);

  const rest = discordRestConfig(env);
  await markSeen(rest, message.channelId, message.messageId);

  /*
    待ちが解けたので作業中に戻す。**握りも同じことをする**が、握りが既に
    落ちていることがあるので両方でやる（同じ状態を 2 回書くだけ）。
  */
  await markRunResumed(db, run.runKey);

  /*
    **質問からボタンを消して、書いた内容を添える**（要件 `F-C2` の 1 行目）。
    ボタンを残すと、答え済みの問いをもう一度押せる形が画面に残る。
    ボタン経路は interaction の type 7 で差し替えられるが、**素の文の経路には
    interaction が無い**ので bot token で PATCH する。
  */
  const ask = await findAsk(db, askId);
  if (ask !== null && ask.messageId !== null) {
    const edited = await editMessage(
      rest,
      threadOf(run),
      ask.messageId,
      askAnsweredMessage(ask.question, body),
    );
    if (!edited.ok) {
      // **本題は止めない。** 台帳には答えが入っていて、Claude へは渡る。
      console.warn("[inbound] 質問メッセージを書き換えられませんでした", {
        runKey: run.runKey,
        askId,
        reason: edited.reason,
      });
    }
  }

  return { decision: "answer", runKey: run.runKey };
};

/* ---- 4-b. 作業中なので預かる ---- */

/**
 * **積むのが印より先。** 計画 P4 §3-5 は「👀 を付ける → `inbox` に積む」と
 * 書いているが、逆順にすると**再送されたメッセージに 👀 を付け直す** ——
 * 既に ✅ になっている文が 👀 に戻る。`inbox_message_uidx` が
 * 「初めて見たか」を答えられるので、それを見てから印を付ける。
 */
const applyQueue = async (
  env: WorkerEnv,
  db: Db,
  run: RunRecord,
  message: InboundMessage,
  body: string,
): Promise<InboundOutcome> => {
  const queued = await queueMessage(
    db,
    {
      runKey: run.runKey,
      authorDiscordUserId: message.authorId,
      messageId: message.messageId,
      body,
    },
    Date.now(),
  );

  if (!queued) return { decision: "duplicate", runKey: run.runKey };

  await markSeen(discordRestConfig(env), message.channelId, message.messageId);
  return { decision: "queue", runKey: run.runKey };
};

/* ---- 4-c. 終わっている / 落ちているので起こし直す ---- */

/**
 * 前の run を畳んで、**同じスレッドに**新しい run を立てる（要件 `I-13`）。
 *
 * **印を立てる順序が要件そのもの**（要件 `I-3`・計画 P4 §3-5）:
 *
 * ```txt
 * peek（読むだけ）→ 起動 → 起動できた → taken を立てる → ✅ に付け替える
 *                       → 起動できない → 何も立てない（次の 1 行で拾い直せる）
 * ```
 *
 * **先に印を立てると、起動に失敗した文がどこにも残らない。**
 */
const applyRestart = async (
  env: WorkerEnv,
  db: Db,
  run: RunRecord,
  message: InboundMessage,
  body: string,
): Promise<InboundOutcome> => {
  const rest = discordRestConfig(env);
  const thread = run.threadId;

  /*
    **スレッドを持たない run は起こし直せない。** 起こし直しは「このスレッドの
    続き」なので、掛ける場所が無い（要件 `F-A7` の run はそもそも素の文が届かない）。
  */
  if (thread === null) return ignored();

  // 今回の文も `inbox` を通す（**再送の判定と「どの run に渡ったか」の記録を 1 か所に**）。
  const queued = await queueMessage(
    db,
    {
      runKey: run.runKey,
      authorDiscordUserId: message.authorId,
      messageId: message.messageId,
      body,
    },
    Date.now(),
  );
  if (!queued) return { decision: "duplicate", runKey: run.runKey };

  await markSeen(rest, message.channelId, message.messageId);

  const project = await findProjectById(db, run.projectId);
  if (project === null || project.disabledAt !== null) {
    console.warn("[inbound] 起こし直せるプロジェクトがありません", {
      runKey: run.runKey,
      projectId: run.projectId,
    });
    await postMessage(
      rest,
      thread,
      noticeMessage(
        "このスレッドのプロジェクトが無効化されているので起こし直せません。",
      ),
    );
    return { decision: "restart", runKey: null };
  }

  /*
    **`run_key` ではなくスレッドで引く。** 前の起こし直しが起動に失敗していると、
    溜まった行は**前の run のまま**残っていて、いちばん新しい run（`failed`）で
    引くと拾えない（`peekQueuedInThread` の why を参照）。
  */
  const pending = await peekQueuedInThread(db, thread);
  const prompt = foldInboundLines(pending.map((row) => row.body));
  if (prompt === "") return ignored();

  const nextRunKey = newRunKey((byteLength) =>
    crypto.getRandomValues(new Uint8Array(byteLength)),
  );

  /*
    **`batch` で 1 回**（要件 `I-13`）。D1 は対話的トランザクションを持たないので、
    「前を `abandoned` にする」と「新しい run を入れる」を分けると
    `runs_live_thread_uidx` の UNIQUE 違反で落ちる。
  */
  await abandonAndStart(
    db,
    {
      previousRunKey: run.runKey,
      reason: "素の文で起こし直したため",
      run: {
        runKey: nextRunKey,
        projectId: project.id,
        prompt,
        requesterDiscordUserId: message.authorId,
        channelId: run.channelId,
        threadId: thread,
      },
    },
    Date.now(),
  );

  const fired = await fireRoutine(
    {
      fetch: outboundFetch,
      takeFireToken: (projectId) =>
        takeFireToken(db, env.FIRE_TOKEN_KEY, projectId),
    },
    {
      projectId: project.id,
      fireUrl: project.fireUrl,
      text: buildFireText(nextRunKey, prompt),
    },
  );

  if (!fired.ok) {
    /*
      **印を立てない。** 溜めた文はそのまま `inbox` に残るので、
      次の 1 行が来たときに一緒に拾い直せる（要件 `I-3`）。
    */
    await markRunFailed(db, nextRunKey, fired.reason, Date.now());
    await postMessage(
      rest,
      thread,
      noticeMessage(
        `起こし直せませんでした（${nextRunKey}）: ${fired.reason}\n書いた内容は預かったままなので、直したらもう一度書いてください。`,
      ),
    );
    return { decision: "restart", runKey: nextRunKey };
  }

  await markRunRunning(db, nextRunKey, fired.session);

  /*
   **起動できてから印を立てる。** `taken_by_run_key` に入るのは
   **実際に渡った run**（届いた先とは違う。テーブル定義書 §4-6）。
   */
  const taken = await markQueuedTaken(
    db,
    pending.map((row) => row.id),
    nextRunKey,
    Date.now(),
  );

  await postMessage(
    rest,
    thread,
    noticeMessage(
      `起こし直しました（${nextRunKey}）。書いた内容を ${taken.length} 件渡しました。`,
    ),
  );

  // **`taken_at` を立てるのと同じ場所で ✅ に付け替える**（要件 `I-3`・`F-C4`）。
  await flipTakenMarks(env, pending, taken, thread);

  return { decision: "restart", runKey: nextRunKey };
};

/**
 * 渡し終わった文の 👀 を ✅ に付け替える。
 *
 * **印を立てられた行だけ**（`markQueuedTaken` が返した id）。「peek した全部」に
 * すると、競走で負けた行にも ✅ が付いて印が嘘になる。
 */
const flipTakenMarks = async (
  env: WorkerEnv,
  pending: readonly {
    readonly id: number;
    readonly messageId: string | null;
  }[],
  takenIds: readonly number[],
  channelId: string,
): Promise<void> => {
  const rest = discordRestConfig(env);
  const taken = new Set(takenIds);

  for (const row of pending) {
    if (!taken.has(row.id) || row.messageId === null) continue;
    await markHandedOff(rest, channelId, row.messageId);
  }
};
