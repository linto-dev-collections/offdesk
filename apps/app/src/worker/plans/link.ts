import { constantTimeEqual } from "@offdesk/domain";

/** 既定 7 日（計画 P6 §7）。 */
export const PLAN_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const toBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const hmac = async (key: string, message: string): Promise<string> => {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(message),
  );

  return toBase64Url(new Uint8Array(signature));
};

/**
 * 署名の対象は **`plan_id` と期限の対**。
 *
 * `plan_id` を含めるので、ある計画のトークンを別の計画に付け替えられない。
 * 期限を含めるので、期限だけを書き換えられない。
 */
const payloadOf = (planId: string, expMs: number): string =>
  `${planId}.${expMs}`;

/**
 * リンクに載せるトークン。**形は `<期限>.<署名>`。**
 *
 * 計画 P6 §7 は `base64url(exp.sig)` と書いているが、**外側の符号化を 1 枚
 * 剥がした。** 期限は秘密ではない（JWT も平文で載せる）し、平文で読めると
 * **「期限切れ」と「署名が違う」を台帳を引く前に書き分けられる** ——
 * 読み手が取るべき行動が違うので、そこは分けたい（`planLinkExpiredPage`）。
 * 符号化の層が減るぶん、取り違える箇所も減る。
 */
export const signPlanLink = async (
  key: string,
  planId: string,
  expMs: number,
): Promise<string> => `${expMs}.${await hmac(key, payloadOf(planId, expMs))}`;

export type PlanLinkVerdict = "ok" | "expired" | "invalid" | "unconfigured";

/**
 * トークンを検査する。**台帳を引く前に呼ぶ。**
 *
 * 先に引くと、署名の無い要求でも `plan_id` の存在の有無が応答の速さや
 * 内容から読み取れる（脅威 17）。ここで落ちれば、**存在しない計画でも
 * 同じ応答**になる。
 *
 * 比較は `constantTimeEqual`（脅威 2 と同じ関数）。
 */
export const verifyPlanLink = async (
  key: string | undefined,
  planId: string,
  token: string | undefined,
  nowMs: number,
): Promise<PlanLinkVerdict> => {
  /*
    **鍵が無ければ誰も通さない**（fail-closed。要件 `I-2` と同じ構え）。
    「鍵が無いから検査を飛ばす」にすると、設定漏れが公開になる。
  */
  const secret = key?.trim() ?? "";
  if (secret === "") return "unconfigured";
  if (token === undefined || token === "") return "invalid";

  const separator = token.indexOf(".");
  if (separator < 0) return "invalid";

  const rawExp = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  // **`Number` に任せない。** `Number(" 1e999 ")` のような値を弾く。
  if (!/^[0-9]{1,15}$/.test(rawExp)) return "invalid";

  const expMs = Number(rawExp);
  const expected = await hmac(secret, payloadOf(planId, expMs));
  /*
    **署名を先に見る。** 期限切れを先に返すと、署名が合っていないトークンでも
    「期限切れ」と答えることになり、`exp` を書き換えるだけで
    「署名は合っている」かどうかを覗ける。
  */
  if (!constantTimeEqual(signature, expected)) return "invalid";

  return nowMs < expMs ? "ok" : "expired";
};

/**
 * 依頼者に貼る URL（`finish` の応答）。
 *
 * **末尾のスラッシュを落とさない。** `/p/<id>` だと `./phase-01.md` が
 * `/p/phase-01.md` に解決されて、計画の中の相対リンクが全部死ぬ。
 */
export const planLinkUrl = (input: {
  readonly origin: string;
  readonly planId: string;
  readonly token: string;
}): string =>
  `${input.origin}/p/${input.planId}/?t=${encodeURIComponent(input.token)}`;
