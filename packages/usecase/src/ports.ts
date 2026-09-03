import type { FireOutcome } from "@offdesk/domain";

/*
  ユースケースが見る口（要件 §10-3 ルール 3）。**実装はアダプタに置く。**
  ここに `D1Database` も `fetch` も Discord の JSON も現れないので、
  ユースケースは D1 も Discord も無しでテストできる。
*/

export type RunLedgerPort = {
  readonly insert: (input: {
    readonly runKey: string;
    readonly projectId: string;
    readonly prompt: string;
    readonly requesterDiscordUserId: string;
    readonly channelId: string;
  }) => Promise<void>;
  readonly attachThread: (runKey: string, threadId: string) => Promise<void>;
  readonly markRunning: (
    runKey: string,
    session: {
      readonly ccSessionId: string;
      readonly ccSessionUrl: string;
    } | null,
  ) => Promise<void>;
  readonly markFailed: (runKey: string, reason: string) => Promise<void>;
};

/** 起動メッセージに出すもの（要件 `F-A4`）。**対象リポジトリを 1 行**含む。 */
export type StartedAnnouncement = {
  readonly runKey: string;
  readonly projectName: string;
  readonly repoUrl: string;
  readonly prompt: string;
};

export type PostResult =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Discord へ出す口。**「親メッセージを出す」と「そこからスレッドを立てる」を分ける。**
 * スレッド作成が失敗しても親メッセージは残るので、通知の落とし先がある（要件 `F-A7`）。
 */
export type AnnouncerPort = {
  readonly postAnchor: (
    channelId: string,
    announcement: StartedAnnouncement,
  ) => Promise<PostResult>;
  readonly openThread: (
    channelId: string,
    messageId: string,
    name: string,
  ) => Promise<PostResult>;
  readonly postText: (channelId: string, text: string) => Promise<PostResult>;
};

export type RoutineLauncherPort = {
  readonly fire: (input: {
    readonly projectId: string;
    readonly fireUrl: string;
    readonly text: string;
  }) => Promise<FireOutcome>;
};
