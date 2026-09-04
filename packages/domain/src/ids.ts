export type RandomBytes = (byteLength: number) => Uint8Array;

const RUN_KEY_PREFIX = "OFFDESK-";
const RUN_KEY_RANDOM_BYTES = 8;

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export const newRunKey = (randomBytes: RandomBytes): string =>
  `${RUN_KEY_PREFIX}${toHex(randomBytes(RUN_KEY_RANDOM_BYTES))}`;

const ASK_ID_PREFIX = "ask_";
const ASK_ID_RANDOM_BYTES = 8;

export const newAskId = (randomBytes: RandomBytes): string =>
  `${ASK_ID_PREFIX}${toHex(randomBytes(ASK_ID_RANDOM_BYTES))}`;

const PLAN_ID_RANDOM_BYTES = 16;

/**
 * 計画の識別子（32hex。`plans_id_shape_ck`）。
 *
 * **128bit の乱数であることが要る**（計画 P6 §8）。`Math.random` を使わない ——
 * 署名付きリンク（脅威 17）はこの識別子の上に乗るし、上書きしても URL が
 * 変わらないという `I-6` の担保に不変な識別子が要る。
 */
export const newPlanId = (randomBytes: RandomBytes): string =>
  toHex(randomBytes(PLAN_ID_RANDOM_BYTES));
