export type SignatureVerdict = "ok" | "invalid" | "stale" | "unconfigured";

/**
 * `X-Signature-Timestamp` を新しいとみなす幅（前後それぞれ）。
 *
 * **署名が正しいことは「いま来た」を意味しない**（plans/security.md 脅威 14 の
 * 続き。2026-09-16 に足した）。Ed25519 は「Discord が作った本物か」しか
 * 言わないので、一度撮られた正規の要求は**何か月後でも同じ検査を通る** ——
 * `/offdesk` の再生 1 回が routine の実行回数を 1 つ消費する。
 *
 * **5 分。** Discord 自身の interaction の期限（3 秒で応答・token は 15 分）
 * より広く取るのは、時計のずれと配送の遅れで正規の要求を落とさないため。
 * **窓の中の再送は `discord_interactions` が止める** —— こちらは
 * 「古いものを捨てる」だけの粗い門で、細かい判定は台帳の仕事。
 *
 * **未来側にも窓を置く。** こちらの時計が遅れている場合があるので片側にしない。
 */
export const DISCORD_SIGNATURE_WINDOW_MS = 5 * 60_000;

/**
 * 署名に使われた timestamp（unix 秒の文字列）が窓の中か。
 *
 * **数字以外は落とす。** `Number("")` は 0、`Number(" 1 ")` は 1 なので、
 * 素直に `Number(raw)` と書くと空文字が 1970 年として通り、**窓の外なので
 * 結果的に落ちる**が、落ちる理由が「空」ではなく「古い」になって読みにくい。
 */
export const isTimestampFresh = (
  raw: string,
  nowMs: number,
  windowMs: number = DISCORD_SIGNATURE_WINDOW_MS,
): boolean => {
  if (!/^[0-9]+$/.test(raw)) return false;

  const seconds = Number(raw);
  if (!Number.isFinite(seconds)) return false;

  return Math.abs(nowMs - seconds * 1000) <= windowMs;
};

const hexToBytes = (hex: string): Uint8Array | null => {
  if (hex.length === 0 || hex.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;

  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
};

export const verifyDiscordSignature = async (input: {
  readonly publicKey: string | undefined;
  readonly signature: string | undefined;
  readonly timestamp: string | undefined;
  readonly body: string;
  readonly nowMs: number;
  readonly windowMs?: number;
}): Promise<SignatureVerdict> => {
  const publicKeyHex = input.publicKey?.trim() ?? "";
  if (publicKeyHex === "") return "unconfigured";

  const publicKey = hexToBytes(publicKeyHex);
  if (publicKey === null) return "unconfigured";

  if (input.signature === undefined || input.timestamp === undefined) {
    return "invalid";
  }

  /*
    **新しさを署名より先に見る。** どちらの順でも結論は同じだが、
    古い要求に対して Ed25519 の検証（CPU を使う）を走らせる理由が無い。
    `timestamp` は署名の対象に入っているので、**書き換えれば署名が壊れる** ——
    「古い要求を新しく見せる」はできない。
  */
  if (!isTimestampFresh(input.timestamp, input.nowMs, input.windowMs)) {
    return "stale";
  }

  const signature = hexToBytes(input.signature);
  if (signature === null) return "invalid";

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      publicKey,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const verified = await crypto.subtle.verify(
      "Ed25519",
      key,
      signature,
      new TextEncoder().encode(input.timestamp + input.body),
    );
    return verified ? "ok" : "invalid";
  } catch {
    return "invalid";
  }
};
