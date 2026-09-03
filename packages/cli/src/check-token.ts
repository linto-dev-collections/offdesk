import { MAX_FIRE_TEXT_LENGTH } from "@offdesk/domain";

export type TokenVerdict = {
  readonly ok: boolean;
  readonly status: number;
  readonly detail: string;
};

/**
 * fire トークンが本当に通るかを、**セッションを作らずに**確かめる。
 *
 * fire は上限（65,536 字）超えの `text` を**認証の後で**弾く。だから故意に長い text を
 * 送れば `400` = 認証は通った / `401` = 通っていない と切り分けられる。どちらでも
 * セッションは作られないので実行回数を消費しない（kanata で確立した手）。
 *
 * **形を見るのではなく実際に叩く**のが肝。`sk-ant-x` のような「それらしい」置き換え
 * 文字列は Zod をすり抜ける。実際にすり抜けて本番へ送られた事故がある。
 */
export const checkFireToken = async (project: {
  readonly fireUrl: string;
  readonly fireToken: string;
}): Promise<TokenVerdict> => {
  let response: Response;
  try {
    response = await fetch(project.fireUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${project.fireToken}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "experimental-cc-routine-2026-04-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: "x".repeat(MAX_FIRE_TEXT_LENGTH + 1) }),
    });
  } catch {
    return { ok: false, status: 0, detail: "届きませんでした" };
  }

  if (response.status === 401) {
    return { ok: false, status: 401, detail: "トークンが通りません" };
  }
  if (response.status === 404) {
    return {
      ok: false,
      status: 404,
      detail: "fireUrl の routine がありません",
    };
  }
  // 400 は「長すぎる」を弾かれただけ ＝ 認証は通っている。429 などは判定できないので通す。
  return { ok: true, status: response.status, detail: "" };
};
