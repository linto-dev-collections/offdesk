import {
  type AskRecord,
  attachAskMessage,
  attachEventMessage,
  createDb,
  type Db,
  findAsk,
  findLatestUndeliveredAsk,
  findRun,
  type InboxRecord,
  insertAsk,
  insertEvent,
  isTerminalStatus,
  markAskDelivered,
  markQueuedTaken,
  markRunResumed,
  markRunWaiting,
  peekQueued,
  type RunRecord,
  touchRunActivity,
  touchRunHeld,
} from "@offdesk/db";
import {
  contextLine,
  contextWindowFor,
  foldInboundLines,
  isAskProblem,
  isHeldAlive,
  isReportProblem,
  isResendQuestion,
  MAX_ASK_OPTIONS,
  newAskId,
  REPORT_KINDS,
  RESEND_QUESTION,
  resolveHoldConfig,
  SERVER_INSTRUCTIONS,
  validateAsk,
  validateReport,
} from "@offdesk/domain";
import { askMessage, reportMessage } from "../discord/components.ts";
import { markHandedOff } from "../discord/marks.ts";
import { postMessage } from "../discord/rest.ts";
import type { WorkerEnv } from "../env.ts";
import { discordRestConfig } from "../session/launch.ts";
import { holdForAnswer } from "./hold.ts";
import {
  INVALID_PARAMS,
  type JsonRpcId,
  type JsonRpcRequest,
  METHOD_NOT_FOUND,
  modernProtocolVersion,
  PARSE_ERROR,
  progressTokenOf,
  rpcError,
  rpcResult,
  toolResult,
  toolStatusResult,
  UNSUPPORTED_PROTOCOL_VERSION,
} from "./jsonrpc.ts";

/**
 * offdesk が話す版。**すべて legacy**（`initialize` で 1 度だけ交渉する世代）。
 *
 * **`2026-07-28`（modern）は実装しない。** あちらは版・識別・capability を
 * 毎要求の `_meta` で運び、`server/discover` を必須にし、ヘッダと本文の一致検査
 * （`-32020`）と MRTR を持つ —— 握り（要件 `F-B1`）は modern でも合法なので
 * 急ぐ理由が無く、**動いている経路を作り直す危険の方が大きい。**
 * 代わりに `unsupportedProtocolVersion` で「legacy へ降りてこい」と明示する。
 */
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
const LATEST_PROTOCOL_VERSION = PROTOCOL_VERSIONS[0];

/** modern だけが持つ RPC。**来た時点で相手が modern だと分かる。** */
const MODERN_ONLY_METHOD = "server/discover";

const SERVER_INFO = { name: "offdesk", version: "0.4.0" } as const;

const RUN_KEY_DESCRIPTION =
  "指示の 1 行目にある OFFDESK- で始まる値。そのまま渡すこと";

const TOOLS = [
  {
    name: "ask_human",
    title: "依頼者に確認する",
    description:
      "判断が要ることを依頼者に確認し、答えが返るまで待つ。選択肢はボタンとして Discord に出る。" +
      "答えが返るまでこの呼び出しは戻らない（待っている間トークンは消費しない）。" +
      `選択肢を挙げられるなら options を渡すこと（1〜${MAX_ASK_OPTIONS} 個）—— ボタンで 1 回押すだけで答えられる。挙げられない問いは options なしでもよく、依頼者はスレッドに直接書いて答える。` +
      "「やったこと」と「次はどうするか」は 1 回にまとめること。" +
      `接続エラーで落ちて ask_id が手元に無いときは、同じ run_key でこれを呼び直せばよい —— question は "${RESEND_QUESTION}" の 1 語でよく、options は要らない。直前の問いを握り直すか、切れている間に届いた答えを返す。質問が 2 回出ることはない。` +
      "作業中に依頼者がスレッドへ書いていた場合は、質問を出さずにその内容を返す。",
    inputSchema: {
      type: "object",
      properties: {
        run_key: { type: "string", description: RUN_KEY_DESCRIPTION },
        question: {
          type: "string",
          description: `確認したいこと。前提も含めて自己完結させる（拾い直すだけなら "${RESEND_QUESTION}"）`,
        },
        options: {
          type: "array",
          items: { type: "string" },
          description: `選ばせたい選択肢（1〜${MAX_ASK_OPTIONS} 個）。ボタンのラベルになる。挙げられないときは省略してよい（依頼者がスレッドに書いて答える）`,
        },
      },
      required: ["run_key", "question"],
    },
  },
  {
    name: "ask_wait",
    title: "回答を待ち直す",
    description:
      "ask_human が status:pending を返したとき、同じ ask_id で回答を待ち直す。" +
      "Discord に質問を出し直すことはない（出したままの問いを握り直す）。" +
      "既に答えを渡した ask_id で呼んでも、同じ答えをもう一度返す。",
    inputSchema: {
      type: "object",
      properties: {
        ask_id: {
          type: "string",
          description: "ask_human が返した ask_ で始まる値",
        },
      },
      required: ["ask_id"],
    },
  },
  {
    name: "report",
    title: "進捗を伝える",
    description:
      "依頼者のスレッドへ進捗を出す。**答えを待たない**（すぐ戻る）。" +
      "progress は作業中の報告、blocked は自分では進めなくなったとき、done は一区切り。" +
      "**done を呼んでも会話は終わらない**（終わるのは依頼者が「おわり」と言ったときだけ）。" +
      "答えや次の指示が要るなら report ではなく ask_human を使い、やったことも同じ呼び出しにまとめること。",
    inputSchema: {
      type: "object",
      properties: {
        run_key: { type: "string", description: RUN_KEY_DESCRIPTION },
        kind: { type: "string", enum: [...REPORT_KINDS] },
        body: { type: "string", description: "スレッドに出す本文" },
      },
      required: ["run_key", "kind", "body"],
    },
  },
] as const;

export type Waitable = {
  waitUntil: (promise: Promise<unknown>) => void;
};

/**
 * `Origin` が付いていて、それが自分のオリジンでなければ 403（仕様の MUST）。
 *
 * **DNS リバインディング対策。** `/mcp` を叩くのは cloud session の中の
 * MCP クライアントで、**ブラウザではないので `Origin` を送らない** ——
 * 付いている時点で「ページから叩かれている」ことになる。
 *
 * Bearer（`OFFDESK_TOKEN`）があるので実害は小さいが、**層を 1 つ増やす**のは
 * 安い（要件 `I-2` と同じ構え）。**未設定は素通し**にしない代わりに、
 * `Origin` が無いこと自体は正常なので通す。
 */
const forbiddenOrigin = (request: Request): boolean => {
  const origin = request.headers.get("origin");
  if (origin === null || origin === "") return false;
  return origin !== new URL(request.url).origin;
};

/**
 * modern（`2026-07-28` 以降）の要求に、**決定的に**「その版は話せない」と返す。
 *
 * 仕様の dual-era フォールバックはこう定めている ——
 * 「modern の要求を先に投げ、**`400`** が返ったら本文を見る。**認識できる modern の
 * エラー**（この `-32022`）なら `supported` から選び直し、そうでなければ
 * `initialize` に落ちる。」
 *
 * **`200` ＋ `-32601` ではこの分岐に入らない。** それが 2026-09-06 まで
 * offdesk が返していたもので、繋がっていたのはクライアント側が寛容だったからに過ぎない。
 * ここで `400` ＋ `-32022` ＋ `supported` を返せば、**相手は必ず legacy を選び直す。**
 */
const unsupportedProtocolVersion = (
  id: JsonRpcId,
  requested: string | null,
): Response =>
  rpcError(id, UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version", {
    status: 400,
    data: {
      supported: [...PROTOCOL_VERSIONS],
      ...(requested === null ? {} : { requested }),
    },
  });

export const handleMcp = async (
  request: Request,
  env: WorkerEnv,
  ctx: Waitable,
): Promise<Response> => {
  if (forbiddenOrigin(request)) {
    console.warn("[mcp] 別オリジンからの要求を拒否しました");
    return rpcError(null, INVALID_PARAMS, "Origin not allowed", {
      status: 403,
    });
  }

  let body: JsonRpcRequest;
  try {
    body = (await request.json()) as JsonRpcRequest;
  } catch {
    return rpcError(null, PARSE_ERROR, "JSON として読めません");
  }

  const id = body.id ?? null;
  const method = body.method ?? "";

  /*
    **modern で来ていたら、話せる版を並べて断る**（`unsupportedProtocolVersion`）。

    判定の根拠は 2 つだけ —— 要求が `_meta` で版を名乗っている（modern は必ず
    載せる）か、modern にしか無い `server/discover` を呼んでいるか。
    **`MCP-Protocol-Version` ヘッダは根拠にしない**（`modernProtocolVersion` の why）。
  */
  const declared = modernProtocolVersion(body.params);
  if (
    (declared !== null &&
      !(PROTOCOL_VERSIONS as readonly string[]).includes(declared)) ||
    method === MODERN_ONLY_METHOD
  ) {
    return unsupportedProtocolVersion(id, declared);
  }

  if (
    (body.id === undefined || body.id === null) &&
    method.startsWith("notifications/")
  ) {
    return new Response(null, { status: 202 });
  }

  switch (method) {
    case "initialize": {
      const requested = body.params?.protocolVersion;
      const version =
        typeof requested === "string" &&
        (PROTOCOL_VERSIONS as readonly string[]).includes(requested)
          ? requested
          : LATEST_PROTOCOL_VERSION;

      return rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: SERVER_INSTRUCTIONS,
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS });
    case "tools/call":
      return await callTool(id, body.params ?? {}, env, ctx);
    default:
      return rpcError(id, METHOD_NOT_FOUND, `未対応のメソッド: ${method}`);
  }
};

const callTool = async (
  id: JsonRpcId,
  params: Record<string, unknown>,
  env: WorkerEnv,
  ctx: Waitable,
): Promise<Response> => {
  const name = typeof params.name === "string" ? params.name : "";
  const args = (params.arguments ?? {}) as Record<string, unknown>;

  switch (name) {
    case "ask_human":
      return await askHuman(id, args, env, progressTokenOf(params), ctx);
    case "ask_wait":
      return await askWait(id, args, env, progressTokenOf(params), ctx);
    case "report":
      return await report(id, args, env);
    default:
      return rpcError(id, METHOD_NOT_FOUND, `未対応のツール: ${name}`);
  }
};

/** 問いを出す先。**スレッドが無ければ親チャンネル**（要件 `F-A7` で run に紐付かない run）。 */
const askTarget = (run: {
  readonly threadId: string | null;
  readonly channelId: string;
}): string => run.threadId ?? run.channelId;

type RunGate =
  | { readonly ok: true; readonly run: RunRecord }
  | { readonly ok: false; readonly response: Response };

const gateRun = async (
  db: Db,
  id: JsonRpcId,
  runKey: string,
): Promise<RunGate> => {
  const run = await findRun(db, runKey);
  if (run === null) {
    return {
      ok: false,
      response: toolResult(
        id,
        `run_key「${runKey}」は台帳にありません。` +
          "**offdesk への接続そのものは通っています**（このエラーはサーバーが返しています）。" +
          "指示の 1 行目にある OFFDESK- で始まる値をそのまま渡してください。",
        true,
      ),
    };
  }

  if (isTerminalStatus(run.status)) {
    return {
      ok: false,
      response: toolStatusResult(
        id,
        {
          status: "closed",
          next: `この run は既に終わっています（status: ${run.status}）。これ以上 offdesk のツールを呼ばず、作業を終えてください。返しても誰にも届きません。`,
        },
        true,
      ),
    };
  }

  return { ok: true, run };
};

const flipAnswerMark = async (
  env: WorkerEnv,
  run: RunRecord,
  ask: AskRecord,
): Promise<void> => {
  if (ask.answerMessageId === null) return;
  await markHandedOff(
    discordRestConfig(env),
    askTarget(run),
    ask.answerMessageId,
  );
};

const deliverAnswer = async (
  env: WorkerEnv,
  db: Db,
  id: JsonRpcId,
  run: RunRecord,
  ask: AskRecord,
  note?: string,
): Promise<Response> => {
  await markAskDelivered(db, ask.askId, Date.now());
  await flipAnswerMark(env, run, ask);
  await markRunResumed(db, ask.runKey);

  return toolStatusResult(id, {
    status: "answered",
    ask_id: ask.askId,
    answer: ask.answer,
    ...(note === undefined ? {} : { note }),
  });
};

const deliverQueued = async (
  env: WorkerEnv,
  db: Db,
  id: JsonRpcId,
  run: RunRecord,
  queued: readonly InboxRecord[],
): Promise<Response | null> => {
  const taken = new Set(
    await markQueuedTaken(
      db,
      queued.map((row) => row.id),
      run.runKey,
      Date.now(),
    ),
  );
  const delivered = queued.filter((row) => taken.has(row.id));
  // 競走で全部さらわれた（別の `ask_human` が渡した）。**空の答えを返さない。**
  if (delivered.length === 0) return null;

  await markRunResumed(db, run.runKey);

  const rest = discordRestConfig(env);
  const channel = askTarget(run);
  for (const row of delivered) {
    if (row.messageId !== null) {
      await markHandedOff(rest, channel, row.messageId);
    }
  }

  return toolStatusResult(id, {
    status: "answered",
    answer: foldInboundLines(delivered.map((row) => row.body)),
    note: "作業中に依頼者がスレッドへ書いた内容です。いま渡そうとした質問は出していません。まだ確認が要るなら、この内容を踏まえてもう一度 ask_human を呼んでください。",
  });
};

/**
 * その run の残量の 1 行（要件 `F-D4`・P5 §3-5）。**`null` なら何も足さない。**
 *
 * **`run` は要求の頭で引いたもので構わない。** 通報が来るのは `PreToolUse`
 * （＝このツール呼び出しの直前）なので、`gateRun` が読んだ時点で
 * **いちばん新しい値が入っている** —— それが `Stop` ではなく `PreToolUse` を
 * 表示に使う理由（計画 P5 §3-1）。
 */
const contextTailOf = (run: RunRecord): string | null =>
  contextLine({
    usedTokens: run.ctxUsedTokens,
    windowTokens: contextWindowFor(run.ctxModel),
  });

const askHuman = async (
  id: JsonRpcId,
  args: Record<string, unknown>,
  env: WorkerEnv,
  progressToken: string | number | null,
  ctx: Waitable,
): Promise<Response> => {
  const db = createDb(env.DB);
  const runKey = typeof args.run_key === "string" ? args.run_key : "";

  const gate = await gateRun(db, id, runKey);
  if (!gate.ok) return gate.response;
  const run = gate.run;

  const stranded = await findLatestUndeliveredAsk(db, runKey);

  if (stranded !== null && stranded.answer !== null) {
    // 切れている間に人が答えていた。**質問は出し直さない。**
    return await deliverAnswer(
      env,
      db,
      id,
      run,
      stranded,
      "接続が切れている間に届いた、直前の問いへの回答です。いま渡そうとした質問は出していません。",
    );
  }

  /*
    **同じ run で握りを重ねない**（脅威 16）。

    **`stranded !== null` を条件に入れるのが要点**（2026-09-05 に本番で踏んで直した）。
    `held_at` は**立てるだけで下ろされない印**で（`touchRunHeld` しか無い）、
    握りは 15 秒ごとに更新して終わるので、**終わった直後は最大 15 秒前の値が残る**
    —— `HELD_ALIVE_MS`（60 秒）の窓に入ったままになり、
    **回答を渡した直後の 2 本目が「別の握りが待っている」で断られていた。**

    印だけを見て断れないのは、それが「握りが生きている」ことを意味しないから。
    **生きた握りは必ず未配達の問いを握っている** ——
    `holdForAnswer` の呼び出し口は 3 つ（新しい問い・拾い直し・`ask_wait`）で、
    どれも `delivered_at` が NULL の行を渡す。`delivered_at` が立つのは
    握り自身が答えを書き出した直後だけ。よって

      印は生きている ＋ 未配達の問いが無い  ⇒  握りは無く、印が古いだけ

    が言える。**`held_at` を下ろす側で直さないのは**、`markRunResumed`（＝待ちが
    解けた印）が**握りが生きている間にも呼ばれる**ため —— ボタンと素の文の
    記録側（`discord/interactions.ts`・`discord/inbound.ts`）がそれで、
    そこで印を下ろすとこの防御そのものが穴になる。

    **断るときは必ず `ask_id` を添える。** これが無いと `ask_wait` で
    待ち直す手が無く、Claude は問いを出し直すか諦めるしかない（本番では諦めた）。
  */
  if (stranded !== null && isHeldAlive(run.heldAt, Date.now())) {
    console.warn("[mcp] 握りが重なったので 2 本目を返しました", { runKey });
    return toolStatusResult(id, {
      status: "pending",
      ask_id: stranded.askId,
      next:
        "この run には未配達の問いが残っていて、握りの印もまだ生きています。" +
        "2 本目は握りません —— この ask_id で ask_wait を呼べば、そのまま待ち直せます" +
        "（Discord に質問は出したままです）。",
    });
  }

  const queued = await peekQueued(db, runKey);
  if (queued.length > 0) {
    const handed = await deliverQueued(env, db, id, run, queued);
    if (handed !== null) return handed;
  }

  if (stranded !== null) {
    await touchRunHeld(db, runKey, Date.now());
    return holdForAnswer({
      id,
      db,
      askId: stranded.askId,
      runKey,
      config: resolveHoldConfig(env),
      progressToken,
      waitUntil: (promise) => ctx.waitUntil(promise),
      onDelivered: (ask) => flipAnswerMark(env, run, ask),
    });
  }

  if (isResendQuestion(args.question)) {
    return toolResult(
      id,
      "拾い直せる問いがありません（この run には未配達の問いが 1 つもありません）。" +
        "聞きたいことがあるなら question に本物の問いを書いてください。",
      true,
    );
  }

  const validated = validateAsk({
    question: args.question,
    options: args.options,
  });
  if (isAskProblem(validated)) return toolResult(id, validated.problem, true);

  const askId = newAskId((byteLength) =>
    crypto.getRandomValues(new Uint8Array(byteLength)),
  );

  await touchRunHeld(db, runKey, Date.now());
  await insertAsk(db, { askId, runKey, ...validated }, Date.now());

  const rest = discordRestConfig(env);
  const target = askTarget(run);

  return holdForAnswer({
    id,
    db,
    askId,
    runKey,
    config: resolveHoldConfig(env),
    progressToken,
    waitUntil: (promise) => ctx.waitUntil(promise),
    onDelivered: (answered) => flipAnswerMark(env, run, answered),
    onOpen: async () => {
      const posted = await postMessage(
        rest,
        target,
        askMessage({ askId, ...validated }, contextTailOf(run)),
      );
      if (!posted.ok) return { ok: false, reason: posted.reason };

      await attachAskMessage(db, askId, posted.id);
      await markRunWaiting(db, runKey);
      return { ok: true };
    },
  });
};

const askWait = async (
  id: JsonRpcId,
  args: Record<string, unknown>,
  env: WorkerEnv,
  progressToken: string | number | null,
  ctx: Waitable,
): Promise<Response> => {
  const db = createDb(env.DB);
  const askId = typeof args.ask_id === "string" ? args.ask_id : "";

  const ask = await findAsk(db, askId);
  if (ask === null) {
    return toolResult(
      id,
      `ask_id「${askId}」は見つかりません。ask_human が返した ask_ で始まる値をそのまま渡してください。`,
      true,
    );
  }

  const gate = await gateRun(db, id, ask.runKey);
  if (!gate.ok) return gate.response;

  if (ask.answer !== null) {
    if (ask.deliveredAt !== null) {
      return toolStatusResult(id, {
        status: "answered",
        ask_id: ask.askId,
        answer: ask.answer,
        note: "この回答は既に渡したものです（同じ答えをもう一度返しています）。",
      });
    }
    return await deliverAnswer(env, db, id, gate.run, ask);
  }

  await touchRunHeld(db, ask.runKey, Date.now());
  return holdForAnswer({
    id,
    db,
    askId: ask.askId,
    runKey: ask.runKey,
    config: resolveHoldConfig(env),
    progressToken,
    waitUntil: (promise) => ctx.waitUntil(promise),
    onDelivered: (answered) => flipAnswerMark(env, gate.run, answered),
  });
};

const report = async (
  id: JsonRpcId,
  args: Record<string, unknown>,
  env: WorkerEnv,
): Promise<Response> => {
  const db = createDb(env.DB);
  const runKey = typeof args.run_key === "string" ? args.run_key : "";

  const gate = await gateRun(db, id, runKey);
  if (!gate.ok) return gate.response;

  const validated = validateReport({ kind: args.kind, body: args.body });
  if (isReportProblem(validated)) {
    return toolResult(id, validated.problem, true);
  }

  const eventId = await insertEvent(
    db,
    { runKey, kind: validated.kind, body: validated.body },
    Date.now(),
  );
  await touchRunActivity(db, runKey, Date.now());

  const posted = await postMessage(
    discordRestConfig(env),
    askTarget(gate.run),
    reportMessage(validated.kind, validated.body, contextTailOf(gate.run)),
  );

  if (!posted.ok) {
    console.warn("[mcp] report を Discord へ出せませんでした", {
      runKey,
      kind: validated.kind,
      eventId,
    });
    return toolResult(
      id,
      `記録はしましたが Discord へ出せませんでした（${posted.reason}）。依頼者には届いていません。`,
    );
  }

  await attachEventMessage(db, eventId, posted.id);
  return toolResult(id, "依頼者へ伝えました。");
};
