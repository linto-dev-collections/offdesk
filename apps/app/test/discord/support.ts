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
  /*
    **既定は「いま」。** 署名の窓（`DISCORD_SIGNATURE_WINDOW_MS`）を足したので、
    固定の過去の値を既定にすると**全部のテストが `stale` で 401 になる。**
    古さそのものを見るテストだけが `timestamp` を明示する。
  */
  const timestamp =
    overrides.timestamp ?? String(Math.floor(Date.now() / 1000));
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

export const tamper = (signatureHex: string): string => {
  const last = signatureHex.slice(-1);
  const rotated = last === "0" ? "1" : "0";
  return signatureHex.slice(0, -1) + rotated;
};

export const OWNER_ID = "111111111111111111";
export const STRANGER_ID = "999999999999999999";

/*
  **interaction の id は毎回違う**（`discord_interactions` が同じ id を 2 回
  受け付けない）。テストの中で同じ形の interaction を 2 通送る場面が多いので、
  明示しない限り採番する —— 固定値を既定にすると、2 通目が
  「処理済み」で弾かれて**落ちる理由が分かりにくくなる。**

  同じ id を 2 回送ることそのものを見るテストは `id` を明示する。
*/
let interactionSeq = 0;

/**
 * **数で足さない。** snowflake は 18 桁 ＝ `Number.MAX_SAFE_INTEGER`（16 桁）の
 * 外なので、`700000000000000000 + 1` は `700000000000000000` のまま
 * （実測で踏んだ。id が全部同じになり、2 通目が「処理済み」で弾かれる）。
 * 桁を文字列として組む。
 */
export const nextInteractionId = (): string => {
  interactionSeq += 1;
  return `70000000000000${String(interactionSeq).padStart(4, "0")}`;
};

export const commandInteraction = (input: {
  readonly userId?: string | null;
  readonly task?: string;
  readonly project?: string;
  readonly channelId?: string;
  readonly parentId?: string;
  readonly name?: string;
  readonly issue?: number;
  readonly pr?: number;
  readonly id?: string;
}) => ({
  id: input.id ?? nextInteractionId(),
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
      ...(input.issue === undefined
        ? []
        : [{ name: "issue", value: input.issue }]),
      ...(input.pr === undefined ? [] : [{ name: "pr", value: input.pr }]),
    ],
  },
});

export const componentInteraction = (input: {
  readonly customId: string;
  readonly userId?: string | null;
  readonly messageId?: string;
  readonly id?: string;
}) => ({
  id: input.id ?? nextInteractionId(),
  type: 3,
  token: "interaction-token",
  channel_id: "444444444444444444",
  channel: { id: "444444444444444444", type: 11 },
  message: { id: input.messageId ?? "555555555555555555" },
  ...(input.userId === null
    ? {}
    : { member: { user: { id: input.userId ?? OWNER_ID } } }),
  data: { custom_id: input.customId, component_type: 2 },
});
