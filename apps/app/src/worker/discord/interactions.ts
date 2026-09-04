import {
  answerAskByButton,
  createDb,
  findAsk,
  listProjects,
  markRunResumed,
} from "@offdesk/db";
import {
  isOwner,
  parseAnswerCustomId,
  projectNames,
  resolveProject,
} from "@offdesk/domain";
import type { WorkerEnv } from "../env.ts";
import { discordRestConfig, launchRunWithEnv } from "../session/launch.ts";
import {
  askAnsweredMessage,
  EPHEMERAL,
  ephemeralNotice,
} from "./components.ts";
import { editOriginalResponse } from "./rest.ts";

export const COMMAND_NAME = "offdesk";

const TYPE_PING = 1;
const TYPE_APPLICATION_COMMAND = 2;
const TYPE_MESSAGE_COMPONENT = 3;

const REPLY_PONG = 1;
const REPLY_MESSAGE = 4;
const REPLY_DEFERRED_MESSAGE = 5;
/** 元のメッセージを差し替える。**コンポーネント由来の interaction にしか使えない。** */
const REPLY_UPDATE_MESSAGE = 7;

type InteractionOption = { name?: string; value?: unknown };

export type Interaction = {
  type?: number;
  token?: string;
  channel_id?: string;
  channel?: { id?: string; type?: number; parent_id?: string };
  member?: { user?: { id?: string } };
  user?: { id?: string };
  data?: {
    name?: string;
    custom_id?: string;
    options?: readonly InteractionOption[];
  };
};

type Waitable = { waitUntil: (promise: Promise<unknown>) => void };

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });

const ephemeral = (text: string): Response =>
  json({ type: REPLY_MESSAGE, data: ephemeralNotice(text) });

const actorId = (interaction: Interaction): string | null =>
  interaction.member?.user?.id ?? interaction.user?.id ?? null;

const optionString = (
  interaction: Interaction,
  name: string,
): string | undefined => {
  const option = interaction.data?.options?.find((o) => o.name === name);
  if (typeof option?.value !== "string") return undefined;
  const value = option.value.trim();
  return value === "" ? undefined : value;
};

export const handleInteraction = async (
  interaction: Interaction,
  env: WorkerEnv,
  ctx: Waitable,
): Promise<Response> => {
  if (interaction.type === TYPE_PING) return json({ type: REPLY_PONG });

  const userId = actorId(interaction);

  /*
    plans/security.md 脅威 14。**署名が正しい正規の interaction でも、送り主が
    持ち主でないことがある。** `OWNER_DISCORD_USER_ID` が未設定なら誰も通らない。
    誰が叩いたかは id だけログに残す（要件 `I-2`・脅威 12）。
  */
  if (!isOwner(env.OWNER_DISCORD_USER_ID, userId)) {
    console.warn("[discord] 持ち主以外の interaction を拒否しました", {
      actorId: userId,
    });
    return ephemeral(
      `この bot は持ち主専用です。（あなたの Discord ユーザー ID: ${userId ?? "取得できませんでした"}）`,
    );
  }

  if (interaction.type === TYPE_MESSAGE_COMPONENT) {
    return await handleAnswerButton(interaction, env, ctx, userId ?? "");
  }

  if (interaction.type !== TYPE_APPLICATION_COMMAND) {
    return ephemeral("この操作には対応していません。");
  }

  return await handleCommand(interaction, env, ctx, userId ?? "");
};

const handleCommand = async (
  interaction: Interaction,
  env: WorkerEnv,
  ctx: Waitable,
  requesterId: string,
): Promise<Response> => {
  if (interaction.data?.name !== COMMAND_NAME) {
    return ephemeral("知らないコマンドです。");
  }

  const prompt = optionString(interaction, "task");
  if (prompt === undefined) {
    return ephemeral("指示（task）を入れてください。");
  }

  const projects = await listProjects(createDb(env.DB));
  const resolution = resolveProject(projects, {
    name: optionString(interaction, "project"),
    channelId: interaction.channel?.id ?? interaction.channel_id,
    parentId: interaction.channel?.parent_id,
  });

  if (resolution.kind === "unknown-name") {
    return ephemeral(
      `プロジェクト「${resolution.requested}」は登録されていません。使えるのは: ${projectNames(projects)}`,
    );
  }
  /*
    要件 `F-A2`・計画 P2 §3-2。**黙って選ばない。**
    「1 つしかないからそれ」に倒すと、雑談チャンネルの `/offdesk` が本番リポジトリに飛ぶ。
  */
  if (resolution.kind === "no-binding") {
    return ephemeral(
      projects.length === 0
        ? "プロジェクトが登録されていません。projects:sync で投入してください。"
        : `このチャンネルに紐付いたプロジェクトがありません。project を指定してください: ${projectNames(projects)}`,
    );
  }

  const project = resolution.project;
  const interactionToken = interaction.token;

  /*
    要件 `F-A5`・`I-10`。**3 秒に収まらないので必ず保留を返す。**
    `waitUntil` は応答から 30 秒で切られるので、`queued` のまま止まった run は
    cron が畳む（P8）。**ここで起こし直さない**（要件 `F-A6`）。

    起動メッセージは**プロジェクトのチャンネル**へ新しく出す（テーブル定義書 §4-3 が
    `channel_id` を「スレッドではなく親」と定めている）。スレッドの中で叩かれても
    同じ経路になるので、「スレッドの中にスレッドは作れない」を特別扱いしなくてよい。
  */
  ctx.waitUntil(
    (async () => {
      const outcome = await launchRunWithEnv(env, {
        projectId: project.id,
        projectName: project.name,
        channelId: project.discordChannelId,
        repoUrl: project.repoUrl,
        fireUrl: project.fireUrl,
        prompt,
        requesterDiscordUserId: requesterId,
      });

      if (interactionToken === undefined) return;

      /*
        **`<#id>` で参照する。** URL を組むと guild id が要り、
        `https://discord.com/channels/@me/<id>` は DM の形なのでサーバー内の
        スレッドには当たらない。この記法なら Discord 側がリンクにする。
      */
      const where =
        outcome.threadId === null
          ? "スレッドを作れなかったので、チャンネルに出しました。"
          : `スレッド: <#${outcome.threadId}>`;

      await editOriginalResponse(discordRestConfig(env), interactionToken, {
        content:
          outcome.failureReason === null
            ? `起動しました（${outcome.runKey}）。${where}`
            : `起動できませんでした（${outcome.runKey}）: ${outcome.failureReason}`,
        flags: EPHEMERAL,
      });
    })(),
  );

  return json({
    type: REPLY_DEFERRED_MESSAGE,
    data: { flags: EPHEMERAL },
  });
};

/* ---- 回答ボタン（P3a・要件 `F-B4`） ---- */

/**
 * ボタンで答える。**押した人の持ち主判定は `handleInteraction` が済ませてある**
 * （plans/security.md 脅威 14。全 interaction が同じ 1 つのゲートを通る）。
 *
 * 答えが Claude へ渡るのは**この応答ではなく、握っている `ask_human` の戻り値**。
 * ここでやるのは台帳へ書くことと、Discord の見え方を直すことだけ。
 */
const handleAnswerButton = async (
  interaction: Interaction,
  env: WorkerEnv,
  ctx: Waitable,
  userId: string,
): Promise<Response> => {
  const action = parseAnswerCustomId(interaction.data?.custom_id);
  if (action === null) return ephemeral("この操作には対応していません。");

  const db = createDb(env.DB);
  const ask = await findAsk(db, action.askId);
  if (ask === null) return ephemeral("この質問は見つかりませんでした。");
  if (ask.answer !== null) {
    return ephemeral(`もう「${ask.answer}」と回答済みです。`);
  }

  const option = ask.options[action.index];
  if (option === undefined) {
    return ephemeral("この選択肢は見つかりませんでした。");
  }

  /*
    **先に答えが入っていたら書かない**（`WHERE answer IS NULL` の 1 文）。
    上の `ask.answer !== null` は画面のための早い道で、**競走を裁くのはこちら。**
  */
  const written = await answerAskByButton(
    db,
    ask.askId,
    option,
    userId,
    Date.now(),
  );
  if (!written) return ephemeral("ほぼ同時に別の回答が入りました。");

  /*
    待ちが解けたので作業中に戻す（状態機械の `waiting ─▶ running`）。
    **握りも同じことをする**が、握りが既に落ちていることがあるので両方でやる
    （同じ状態を 2 回書くだけなので、二重に走っても壊れない）。
  */
  ctx.waitUntil(markRunResumed(db, ask.runKey));

  /*
    **ボタンを消して押した内容を添える**（type 7）。`editMessage` を叩かずに
    interaction の応答で差し替えるので、REST の往復が 1 つ減る。
  */
  return json({
    type: REPLY_UPDATE_MESSAGE,
    data: askAnsweredMessage(ask.question, option),
  });
};
