/*
  Discord の interaction を**本物の Ed25519 で署名して**投げるための道具。

  鍵はテストの中で作る。固定の鍵をリポジトリに置くと「その鍵で通る」ことしか
  確かめられず、鍵の読み込み経路（hex → importKey）が壊れても気付けない。
*/

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export type SigningKeys = {
  readonly publicKeyHex: string;
  readonly sign: (message: string) => Promise<string>;
};

export const createSigningKeys = async (): Promise<SigningKeys> => {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;

  // `exportKey` の戻り値は形式によって `ArrayBuffer | JsonWebKey`。"raw" は前者。
  const raw = (await crypto.subtle.exportKey(
    "raw",
    pair.publicKey,
  )) as ArrayBuffer;

  return {
    publicKeyHex: toHex(new Uint8Array(raw)),
    sign: async (message) =>
      toHex(
        new Uint8Array(
          await crypto.subtle.sign(
            "Ed25519",
            pair.privateKey,
            new TextEncoder().encode(message),
          ),
        ),
      ),
  };
};

export const ORIGIN = "http://localhost:5173";

/** Discord は `timestamp + body` に署名する。 */
export const signedRequest = async (
  keys: SigningKeys,
  body: unknown,
  overrides: {
    readonly timestamp?: string;
    readonly signature?: string;
    readonly omitSignature?: boolean;
    readonly omitTimestamp?: boolean;
  } = {},
): Promise<Request> => {
  const raw = JSON.stringify(body);
  const timestamp = overrides.timestamp ?? "1788427539";
  const signature = overrides.signature ?? (await keys.sign(timestamp + raw));

  const headers = new Headers({ "content-type": "application/json" });
  if (overrides.omitSignature !== true) {
    headers.set("x-signature-ed25519", signature);
  }
  if (overrides.omitTimestamp !== true) {
    headers.set("x-signature-timestamp", timestamp);
  }

  return new Request(`${ORIGIN}/discord/interactions`, {
    method: "POST",
    headers,
    body: raw,
  });
};

/** 1 バイトだけ違う署名を作る（末尾の 16 進 1 桁を回す）。 */
export const tamper = (signatureHex: string): string => {
  const last = signatureHex.slice(-1);
  const rotated = last === "0" ? "1" : "0";
  return signatureHex.slice(0, -1) + rotated;
};

export const OWNER_ID = "111111111111111111";
export const STRANGER_ID = "999999999999999999";

export const commandInteraction = (input: {
  readonly userId?: string | null;
  readonly task?: string;
  readonly project?: string;
  readonly channelId?: string;
  readonly parentId?: string;
  readonly name?: string;
}) => ({
  type: 2,
  token: "interaction-token",
  channel_id: input.channelId ?? "111111111111111111",
  channel: {
    id: input.channelId ?? "111111111111111111",
    type: 0,
    ...(input.parentId === undefined ? {} : { parent_id: input.parentId }),
  },
  ...(input.userId === null
    ? {}
    : { member: { user: { id: input.userId ?? OWNER_ID } } }),
  data: {
    name: input.name ?? "offdesk",
    options: [
      ...(input.task === undefined
        ? []
        : [{ name: "task", value: input.task }]),
      ...(input.project === undefined
        ? []
        : [{ name: "project", value: input.project }]),
    ],
  },
});
