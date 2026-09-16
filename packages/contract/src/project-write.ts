import { z } from "zod";
import { ProjectSummary } from "./project.ts";

/*
  プロジェクトを**書く**ときの形（要件 `F-H3`）。`project.ts` から切り出してある。

  **クライアントのバンドルに落とさないため**（計画 P8 §2-2）。`FIRE_URL_PREFIX` は
  `api.anthropic.com` の文字列そのもので、`release/bundle-has-no-secrets.test.ts` が
  client の `.js` に現れることを禁じている —— 秘密ではない（公開のホスト名）が、
  **「クライアントにサーバー側の形が混ざっていない」を機械で言える**状態を保つのが
  この分割の目的。

  Rollup は `z.object(...)` を「副作用があるかもしれない呼び出し」として残すので、
  **画面が読む `ProjectSummary` と同じモジュールに居る限り落とせない**
  （2026-09-05 に実測）。モジュールごと分けると、参照していないバンドルから丸ごと消える。

  **`router.ts` から参照しても落ちる。** 画面は `import { type contract }` と
  型でしか取っていないので、Rollup が `router.ts` ごと落とす
  （2026-09-16 に実測 —— この形にできたので、投入の検証を oRPC の契約に載せられる）。
*/

/**
 * `projects.fire_url` に許す形（plans/security.md 脅威 3 の 2 層目）。
 *
 * 同じ規則を D1 の `projects_fire_url_ck`・`packages/domain/src/fire.ts`・ここが見る。
 * **3 つとも `https://api.anthropic.com/` の前方一致。**
 */
export const FIRE_URL_PREFIX = "https://api.anthropic.com/";

/*
  形を DDL の CHECK に合わせてある（テーブル定義書 §4-1）。DDL に落ちる値が
  ここを通ってしまうと、原因が「D1 の CHECK 違反」という読みにくい形で出る。
*/

/**
 * **名前は作るときにしか決められない**（`ProjectUpdateInput` に無い）。
 *
 * 名前が一致の鍵なので、変えると**別のプロジェクトが増えて古い行が残る**
 * （OPERATIONS §2 の「名前は変えない」）。型として変更できない形にしておけば、
 * 画面にうっかり欄を足しても通らない。
 */
export const ProjectName = z
  .string()
  .min(1)
  .max(32)
  .regex(
    /^[a-z0-9][a-z0-9_-]*$/,
    "name は英小文字・数字・_ - だけで、先頭は英数字にしてください",
  );

export const DiscordChannelId = z
  .string()
  .regex(/^[0-9]{15,24}$/, "discordChannelId は 15〜24 桁の数字です");

export const RepoUrl = z.string().startsWith("https://");

export const FireUrl = z.string().startsWith(FIRE_URL_PREFIX);

export const FireToken = z.string().min(8);

/** プロジェクトの識別子（`projects.id`。cuid2）。 */
export const ProjectId = z.string().min(1).max(64);

export const ProjectCreateInput = z.object({
  name: ProjectName,
  discordChannelId: DiscordChannelId,
  repoUrl: RepoUrl,
  fireUrl: FireUrl,
  fireToken: FireToken,
});
export type ProjectCreateInput = z.infer<typeof ProjectCreateInput>;

/**
 * 直すときの形。**`fireToken` は任意。**
 *
 * **必須にできない。** claude.ai のトークンは**発行時に 1 度しか表示されず**、
 * 再発行すると前のトークンが失効する（`routines-fire` のドキュメント）——
 * 必須にすると、**チャンネルを変えるだけでトークンのローテーションを強制する**
 * ことになる。
 *
 * 省略 ＝ 据え置き、入れた ＝ 差し替え。据え置きの経路は資格情報の行に
 * 触らない（`updateProjectKeepingCredential`）。
 */
export const ProjectUpdateInput = z.object({
  id: ProjectId,
  discordChannelId: DiscordChannelId,
  repoUrl: RepoUrl,
  fireUrl: FireUrl,
  fireToken: FireToken.optional(),
});
export type ProjectUpdateInput = z.infer<typeof ProjectUpdateInput>;

/**
 * 止める・戻す（要件 `F-H5`）。**消すではない。**
 *
 * `runs.project_id` が `RESTRICT` の外部キーなので、run が 1 本でもあるプロジェクトは
 * **構造的に消せない** —— 消せるようにすると run の履歴ごと消すことになる。
 */
export const ProjectDisableInput = z.object({
  id: ProjectId,
  disabled: z.boolean(),
});
export type ProjectDisableInput = z.infer<typeof ProjectDisableInput>;

/**
 * 書いたあとの姿。
 *
 * **`/offdesk` を更新できたかを一緒に返す。** 台帳に入っただけでは Discord の
 * 選択肢に出ないのが OPERATIONS §2 がいちばん強く警告していた取りこぼしで、
 * **画面には出るので気づきにくい** —— 同じ応答で言えば、気づかせる場所が 1 つで済む。
 *
 * **Discord へ出せなくても書き込みは成功扱いにする。** 台帳は正しく、
 * 足りないのは登録し直しだけ（画面のボタンでやり直せる）。
 */
export const ProjectWriteOutput = z.object({
  project: ProjectSummary,
  commandsRegistered: z.boolean(),
});
export type ProjectWriteOutput = z.infer<typeof ProjectWriteOutput>;

/** 名前とチャンネルは一意（要件 `F-H4`）。**どちらが埋まっているかを返す。** */
export const ProjectConflict = z.object({
  field: z.enum(["name", "discordChannelId"]),
});
export type ProjectConflict = z.infer<typeof ProjectConflict>;

/**
 * トークンが通らなかった理由。
 *
 * **理由は種別だけ。** 応答の本文も URL も載せない（脅威 12）——
 * 読む人が取るべき行動がこれで分かれる。
 *
 * **`token_required` だけ叩く前に出る**（2026-09-16）。別の routine を指すように
 * `fireUrl` を変えたのにトークンを省略した編集で、**指す先が変われば
 * いま持っているトークンは必ず通らない**（トークンは routine ごとに発行される）。
 * 以前は通していて、気付くのは次に `/offdesk` を叩いた人が 401 を見たとき。
 */
export const FireTokenProblem = z.object({
  kind: z.enum([
    "rejected",
    "routine_not_found",
    "unreachable",
    "token_required",
  ]),
});
export type FireTokenProblem = z.infer<typeof FireTokenProblem>;

/** `/offdesk` を登録し直した結果。**並んだ名前をそのまま返す**（見て確かめられる）。 */
export const ProjectCommandsOutput = z.object({
  registered: z.array(z.string()),
  scope: z.string(),
});
export type ProjectCommandsOutput = z.infer<typeof ProjectCommandsOutput>;

/**
 * チャンネルの選択肢（計画: 18 桁のスノーフレークを手で貼らせない）。
 *
 * **`GET /guilds/{id}/channels` は bot が見えているものしか返さない**ので、
 * 一覧に出ること自体が「bot が見えている」の確認になる（OPERATIONS §2 の
 * 「bot が見えること」が目視から消える）。
 */
export const DiscordChannelOption = z.object({
  id: z.string(),
  name: z.string(),
  /** 既に別のプロジェクトが使っている（要件 `F-H4` で 2 つ紐付けられない）。 */
  taken: z.boolean(),
});
export type DiscordChannelOption = z.infer<typeof DiscordChannelOption>;

/**
 * **引けないことを型で持つ**（`available: false`）。
 *
 * `DISCORD_GUILD_ID` も `DISCORD_BOT_TOKEN` も `ENDPOINT_GATED_ENV_NAMES` に居て、
 * 欠けても他は動く —— エラーにすると**チャンネルが引けないだけでフォームごと開かない。**
 * 引けないときは手で ID を入れる欄に落とす。
 */
export const ProjectChannelsOutput = z.object({
  available: z.boolean(),
  items: z.array(DiscordChannelOption),
});
export type ProjectChannelsOutput = z.infer<typeof ProjectChannelsOutput>;

/**
 * claude.ai の routine に貼る本文（`ROUTINE_PROMPT`）。
 *
 * **画面から配る。** 正本は `packages/domain/src/prompt.ts` で、ここは運ぶだけ ——
 * クライアントに焼き込むと、**デプロイしていない版の文面を配る**ことになる
 * （プロンプトは routine に焼き込まれるので、ズレても静かに動き続ける）。
 */
export const RoutinePromptOutput = z.object({
  prompt: z.string(),
});
export type RoutinePromptOutput = z.infer<typeof RoutinePromptOutput>;
