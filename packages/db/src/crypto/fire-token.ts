import { FIRE_TOKEN_KEY_VERSION } from "./key-version.ts";

/*
  fire トークンの暗号化（要件 `F-H2`・plans/security.md 脅威 3）。AES-256-GCM。

  **平文はこのモジュールの外へ出さない**——復号した値を返すのは `takeFireToken` だけで、
  その戻り値は routine 起動アダプタのローカル変数より外へ出ない。

  **IV は 1 レコード 1 回。** 同じ鍵で IV を再利用すると GCM は平文が復元できる形で壊れる
  （鍵ストリームが同じになり、2 つの暗号文の XOR が平文の XOR になる）。
*/

const IV_BYTES = 12;
const KEY_BYTES = 32;
const LAST4_LENGTH = 4;

export type EncryptedFireToken = {
  readonly ciphertext: Uint8Array;
  readonly iv: Uint8Array;
  readonly keyVersion: number;
  readonly last4: string;
};

const base64ToBytes = (value: string): Uint8Array => {
  const binary = atob(value.trim());
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

/**
 * **`extractable` を false にする。** 一度読み込んだ鍵を JS から取り出せなくしておけば、
 * 「デバッグのために鍵を出す」コードが書けない。
 */
const importKey = async (keyBase64: string): Promise<CryptoKey> => {
  const raw = base64ToBytes(keyBase64);
  if (raw.byteLength !== KEY_BYTES) {
    throw new Error(
      `FIRE_TOKEN_KEY は base64 の ${KEY_BYTES} バイトである必要があります（いまは ${raw.byteLength} バイト）`,
    );
  }
  return await crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
};

export const encryptFireToken = async (
  keyBase64: string,
  plaintext: string,
): Promise<EncryptedFireToken> => {
  if (plaintext.length < LAST4_LENGTH) {
    throw new Error("fire トークンが短すぎます");
  }

  const key = await importKey(keyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );

  return {
    ciphertext: new Uint8Array(ciphertext),
    iv,
    keyVersion: FIRE_TOKEN_KEY_VERSION,
    // 末尾 4 文字は秘密ではない（突き合わせのための表示。テーブル定義書 §4-2）。
    last4: plaintext.slice(-LAST4_LENGTH),
  };
};

/**
 * **戻り値を掴んだ関数の外へ出さない。** 呼ぶのは `takeFireToken` だけ。
 *
 * 鍵の版で分岐する余地を残してあるが、P2 では版 1 だけ。**知らない版は復号しない**
 * （鍵を回したあとに古い暗号文を新しい鍵で開こうとして「認証タグが合わない」で
 * 落ちるより、版が違うと言った方が原因が分かる）。
 */
export const decryptFireToken = async (
  keyBase64: string,
  encrypted: {
    readonly ciphertext: Uint8Array;
    readonly iv: Uint8Array;
    readonly keyVersion: number;
  },
): Promise<string> => {
  if (encrypted.keyVersion !== FIRE_TOKEN_KEY_VERSION) {
    throw new Error(
      `知らない鍵の版です: ${encrypted.keyVersion}（このビルドが持つのは ${FIRE_TOKEN_KEY_VERSION}）`,
    );
  }

  const key = await importKey(keyBase64);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: encrypted.iv },
    key,
    encrypted.ciphertext,
  );

  return new TextDecoder().decode(plaintext);
};
