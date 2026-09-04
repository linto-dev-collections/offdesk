import type { FireOutcome } from "@offdesk/domain";
import { checkFireUrl, MAX_FIRE_TEXT_LENGTH } from "@offdesk/domain";

/*
  routine を起こす。**fire トークンを載せる唯一の場所**（plans/security.md 脅威 3）。

  ヘッダを組む**前**に `checkFireUrl` を通す。D1 の CHECK と CLI の Zod をすり抜けた値
  （例: 直接 SQL で書き換えられた行）でも、ここで止まる。

  値は kanata の実測に合わせてある（`src/anthropic/routines.ts`）:
  本文のキーは `text`（`prompt` ではない）。`anthropic-beta` が無いと 400 になる。
*/

const ANTHROPIC_VERSION = "2023-06-01";

/**
 * 研究プレビューなので、日付つきの新しいヘッダが出たらここを上げる
 * （直前 2 世代は動き続ける）。**無いと 400 になる。**
 */
const FIRE_BETA_HEADER = "experimental-cc-routine-2026-04-01";

export type FireRoutineDeps = {
  readonly fetch: typeof fetch;
  readonly takeFireToken: (projectId: string) => Promise<string | null>;
};

export type FireRoutineInput = {
  readonly projectId: string;
  readonly fireUrl: string;
  readonly text: string;
};

type FireResponseBody = {
  claude_code_session_id?: unknown;
  claude_code_session_url?: unknown;
};

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

export const fireRoutine = async (
  deps: FireRoutineDeps,
  input: FireRoutineInput,
): Promise<FireOutcome> => {
  const urlProblem = checkFireUrl(input.fireUrl);
  if (urlProblem !== null) {
    console.warn("[fire] fire_url が許可された宛先ではありません", {
      projectId: input.projectId,
    });
    return { ok: false, reason: urlProblem.message };
  }

  if (input.text.length > MAX_FIRE_TEXT_LENGTH) {
    return {
      ok: false,
      reason: `指示が長すぎます（${input.text.length} 字 / 上限 ${MAX_FIRE_TEXT_LENGTH} 字）`,
    };
  }

  /*
    **復号の失敗を投げさせない。** ここで例外が抜けると run は `queued` のまま止まり、
    「何も起きない」だけが見える（`FIRE_TOKEN_KEY` の未設定・鍵長違い・版違いが全部これ）。
    理由は返すが、鍵も暗号文も載せない（脅威 12）。
  */
  let token: string | null;
  try {
    token = await deps.takeFireToken(input.projectId);
  } catch (error) {
    console.warn("[fire] fire トークンを復号できませんでした", {
      projectId: input.projectId,
      cause: error instanceof Error ? error.message : "unknown",
    });
    return { ok: false, reason: "fire トークンを復号できませんでした" };
  }
  if (token === null) {
    return { ok: false, reason: "fire トークンが登録されていません" };
  }

  let response: Response;
  try {
    response = await deps.fetch(input.fireUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-beta": FIRE_BETA_HEADER,
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: input.text }),
    });
  } catch (error) {
    // 戻り値には入れないが、**ログには残す**（`this` の取り違えとネットワーク断を
    // 区別できないと切り分けに 1 往復かかる。P2 §9-9）。宛先 URL は載せない。
    console.warn("[fire] fetch が例外を投げました", {
      projectId: input.projectId,
      error:
        error instanceof Error ? `${error.name}: ${error.message}` : "unknown",
    });
    return { ok: false, reason: "routine の起動に届きませんでした" };
  }

  /*
    **応答の本文をログにも戻り値にも入れない**（脅威 12）。トークンを echo する API を
    想定しないという話ではなく、「秘密を送った相手の応答は秘密として扱う」という規則。
    切り分けに要るのは状態コードだけで、それは Cloudflare のログに残る。
  */
  if (!response.ok) {
    console.warn("[fire] routine が失敗を返しました", {
      projectId: input.projectId,
      status: response.status,
    });
    return {
      ok: false,
      reason: `routine が ${response.status} を返しました`,
    };
  }

  /*
    **応答の形が変わっても run は `running` にする**（計画 P2 §7）。起動そのものは
    成功しているので `failed` に畳むと嘘になる。id と URL は `runs_cc_pair_ck` があるので
    片方だけ入れず、両方 NULL にする。
  */
  let body: FireResponseBody;
  try {
    body = (await response.json()) as FireResponseBody;
  } catch {
    console.warn("[fire] 応答が JSON ではありませんでした", {
      projectId: input.projectId,
    });
    return { ok: true, session: null };
  }

  const ccSessionId = asString(body.claude_code_session_id);
  const ccSessionUrl = asString(body.claude_code_session_url);
  if (ccSessionId === null || ccSessionUrl === null) {
    console.warn("[fire] 応答にセッションの id と URL が揃っていません", {
      projectId: input.projectId,
    });
    return { ok: true, session: null };
  }

  return { ok: true, session: { ccSessionId, ccSessionUrl } };
};
