import type { FireTokenVerdict } from "@offdesk/domain";
import { sameRoutine } from "@offdesk/domain";
import type { ProjectSummaryView } from "./list-projects.ts";
import { toProjectSummary } from "./list-projects.ts";

/*
  プロジェクトを書く（要件 `F-H1`〜`F-H5`）。

  **平文の `fireToken` はこのモジュールの引数より外へ出ない。** `verify` に渡して
  `encrypt` に渡した後は暗号文だけを持ち回り、戻り値には末尾 4 文字しか載せない
  （脅威 3・12）。

  **確かめてから書く。** `projects.json` と CLI を畳んだ 2026-09-16 まで、
  トークンの実叩きは CLI の `check` が持っていた —— 画面へ移すときに落とすと、
  **形だけ合っている置き換え文字列が本番に入る**（実際に起きた事故）。
*/

export type FireTokenCipherPort = {
  readonly encrypt: (plaintext: string) => Promise<{
    readonly ciphertext: Uint8Array;
    readonly iv: Uint8Array;
    readonly keyVersion: number;
    readonly last4: string;
  }>;
};

/** トークンを**セッションを作らずに**確かめる口（実装は `packages/db` のアダプタ）。 */
export type FireTokenVerifierPort = {
  readonly verify: (input: {
    readonly fireUrl: string;
    readonly fireToken: string;
  }) => Promise<FireTokenVerdict>;
};

type ProjectRow = {
  readonly id: string;
  readonly name: string;
  readonly discordChannelId: string;
  readonly repoUrl: string;
  readonly fireUrl: string;
  readonly fireTokenLast4: string | null;
  readonly disabledAt: number | null;
};

export type ProjectStoreWritePort = {
  readonly findByName: (
    name: string,
  ) => Promise<{ readonly id: string } | null>;
  readonly findByChannel: (
    channelId: string,
  ) => Promise<{ readonly id: string } | null>;
  readonly findWithMask: (id: string) => Promise<ProjectRow | null>;
  readonly upsert: (
    input: {
      readonly name: string;
      readonly discordChannelId: string;
      readonly repoUrl: string;
      readonly fireUrl: string;
    },
    encrypted: {
      readonly ciphertext: Uint8Array;
      readonly iv: Uint8Array;
      readonly keyVersion: number;
      readonly last4: string;
    },
  ) => Promise<{ readonly projectId: string; readonly inserted: boolean }>;
  /**
   * **暗号文も一緒に渡す口**（2026-09-16 に 1 本へ畳んだ）。
   *
   * 以前は「行を書き換える」と「資格情報を差し替える」の 2 本で、
   * **後半が落ちると新しい `fire_url` と古いトークンが残った。**
   * 実装は D1 の `batch`（＝ 原子性の単位）。
   */
  readonly update: (
    input: {
      readonly id: string;
      readonly discordChannelId: string;
      readonly repoUrl: string;
      readonly fireUrl: string;
    },
    /** **`null` は据え置き**（資格情報の行に触らない）。 */
    encrypted: {
      readonly ciphertext: Uint8Array;
      readonly iv: Uint8Array;
      readonly keyVersion: number;
      readonly last4: string;
    } | null,
  ) => Promise<boolean>;
  readonly setDisabled: (id: string, disabled: boolean) => Promise<boolean>;
};

export type WriteProjectDeps = {
  readonly store: ProjectStoreWritePort;
  readonly cipher: FireTokenCipherPort;
  readonly verifier: FireTokenVerifierPort;
  readonly guildId: string | null;
};

/**
 * 失敗の種類。**呼ぶ側（RPC）がそれぞれ別の状態コードへ写す。**
 *
 * ここで HTTP を知らないのが要点 —— ユースケースは「何が起きたか」だけを返し、
 * `409` か `422` かは口の側が決める。
 */
export type WriteProjectProblem =
  | { readonly kind: "conflict"; readonly field: "name" | "discordChannelId" }
  | { readonly kind: "token"; readonly reason: FireTokenBadReason }
  | { readonly kind: "not_found" };

/**
 * **`token_required` だけ叩く前に出る。** 残り 3 つは実際に Anthropic を
 * 叩いた結果（`FireTokenVerdict`）。
 */
export type FireTokenBadReason =
  | "rejected"
  | "routine_not_found"
  | "unreachable"
  | "token_required";

export type WriteProjectResult =
  | { readonly ok: true; readonly project: ProjectSummaryView }
  | { readonly ok: false; readonly problem: WriteProjectProblem };

export type CreateProjectInput = {
  readonly name: string;
  readonly discordChannelId: string;
  readonly repoUrl: string;
  readonly fireUrl: string;
  readonly fireToken: string;
};

export type UpdateProjectInput = {
  readonly id: string;
  readonly discordChannelId: string;
  readonly repoUrl: string;
  readonly fireUrl: string;
  /** **省略 ＝ 据え置き**（`ProjectUpdateInput` の why）。 */
  readonly fireToken?: string;
};

const summaryOf = async (
  deps: WriteProjectDeps,
  id: string,
): Promise<WriteProjectResult> => {
  const row = await deps.store.findWithMask(id);
  if (row === null) return { ok: false, problem: { kind: "not_found" } };

  return { ok: true, project: toProjectSummary(row, deps.guildId) };
};

const verifyToken = async (
  deps: WriteProjectDeps,
  input: { readonly fireUrl: string; readonly fireToken: string },
): Promise<WriteProjectProblem | null> => {
  const verdict = await deps.verifier.verify(input);
  return verdict.ok ? null : { kind: "token", reason: verdict.kind };
};

/**
 * 増やす（要件 `F-H3`）。
 *
 * **順序を入れ替えない** —— 衝突 → トークンの実叩き → 暗号化 → 書き込み。
 * 衝突を先に見るのは、**通らないと分かっている登録で Anthropic を叩かない**ため
 * （叩いても課金はされないが、失敗の理由が 2 つ並ぶと読む人が迷う）。
 */
export const createProject = async (
  deps: WriteProjectDeps,
  input: CreateProjectInput,
): Promise<WriteProjectResult> => {
  if ((await deps.store.findByName(input.name)) !== null) {
    return { ok: false, problem: { kind: "conflict", field: "name" } };
  }
  if ((await deps.store.findByChannel(input.discordChannelId)) !== null) {
    return {
      ok: false,
      problem: { kind: "conflict", field: "discordChannelId" },
    };
  }

  const bad = await verifyToken(deps, input);
  if (bad !== null) return { ok: false, problem: bad };

  const encrypted = await deps.cipher.encrypt(input.fireToken);
  const { projectId } = await deps.store.upsert(
    {
      name: input.name,
      discordChannelId: input.discordChannelId,
      repoUrl: input.repoUrl,
      fireUrl: input.fireUrl,
    },
    encrypted,
  );

  return await summaryOf(deps, projectId);
};

/**
 * 直す。**名前は受け取らない**（一致の鍵なので変えない）。
 *
 * **トークンを渡されたときだけ確かめて差し替える。** 省略なら資格情報の行に
 * 触らないので、チャンネルを変えるだけの編集でローテーションが起きない。
 *
 * **別の routine を指すように変えるならトークンは必須**（2026-09-16）。
 * トークンは routine ごとに発行される（`fire` のドキュメント）ので、
 * 指す先が変われば**いま持っているトークンは必ず通らない** ——
 * 以前はここを通していて、気付くのは次に `/offdesk` を叩いた人が
 * 401 を見たとき（そのときには誰も編集画面を見ていない）。
 * **同じ routine の URL を整形し直すだけの編集は今までどおり通る**
 * （`sameRoutine` が識別子で比べる）。
 */
export const updateProject = async (
  deps: WriteProjectDeps,
  input: UpdateProjectInput,
): Promise<WriteProjectResult> => {
  const current = await deps.store.findWithMask(input.id);
  if (current === null) return { ok: false, problem: { kind: "not_found" } };

  const owner = await deps.store.findByChannel(input.discordChannelId);
  if (owner !== null && owner.id !== input.id) {
    return {
      ok: false,
      problem: { kind: "conflict", field: "discordChannelId" },
    };
  }

  const token = input.fireToken;

  if (token === undefined && !sameRoutine(current.fireUrl, input.fireUrl)) {
    return {
      ok: false,
      problem: { kind: "token", reason: "token_required" },
    };
  }

  /*
    **確かめてから暗号化する。** 順序を入れ替えると、通らないトークンを
    暗号化する仕事が 1 つ増えるだけでなく、**失敗の理由が 2 つ並ぶ。**
  */
  let encrypted: Awaited<ReturnType<FireTokenCipherPort["encrypt"]>> | null =
    null;
  if (token !== undefined) {
    const bad = await verifyToken(deps, {
      fireUrl: input.fireUrl,
      fireToken: token,
    });
    if (bad !== null) return { ok: false, problem: bad };

    encrypted = await deps.cipher.encrypt(token);
  }

  /*
    **1 回の呼び出しで書く**（実装は D1 の `batch`）。分けると、
    後半が落ちたときに**新しい `fire_url` と古いトークン**が残る。
  */
  if (
    !(await deps.store.update(
      {
        id: input.id,
        discordChannelId: input.discordChannelId,
        repoUrl: input.repoUrl,
        fireUrl: input.fireUrl,
      },
      encrypted,
    ))
  ) {
    return { ok: false, problem: { kind: "not_found" } };
  }

  return await summaryOf(deps, input.id);
};

/** 止める・戻す（要件 `F-H5`）。**消す口は無い**（`runs` が参照している）。 */
export const setProjectDisabled = async (
  deps: WriteProjectDeps,
  input: { readonly id: string; readonly disabled: boolean },
): Promise<WriteProjectResult> => {
  if (!(await deps.store.setDisabled(input.id, input.disabled))) {
    return { ok: false, problem: { kind: "not_found" } };
  }

  return await summaryOf(deps, input.id);
};
