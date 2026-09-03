import { createDb, listProjects } from "@offdesk/db";
import { isOwner, projectNames, resolveProject } from "@offdesk/domain";
import type { WorkerEnv } from "../env.ts";
import { discordRestConfig, launchRunWithEnv } from "../session/launch.ts";
import { EPHEMERAL, ephemeralNotice } from "./components.ts";
import { editOriginalResponse } from "./rest.ts";

export const COMMAND_NAME = "offdesk";

const TYPE_PING = 1;
const TYPE_APPLICATION_COMMAND = 2;

const REPLY_PONG = 1;
const REPLY_MESSAGE = 4;
const REPLY_DEFERRED_MESSAGE = 5;

type InteractionOption = { name?: string; value?: unknown };

export type Interaction = {
  type?: number;
  token?: string;
  channel_id?: string;
  channel?: { id?: string; type?: number; parent_id?: string };
  member?: { user?: { id?: string } };
  user?: { id?: string };
  data?: { name?: string; options?: readonly InteractionOption[] };
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
