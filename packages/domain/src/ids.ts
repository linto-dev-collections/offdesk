export type RandomBytes = (byteLength: number) => Uint8Array;

const RUN_KEY_PREFIX = "OFFDESK-";
const RUN_KEY_RANDOM_BYTES = 8;

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export const newRunKey = (randomBytes: RandomBytes): string =>
  `${RUN_KEY_PREFIX}${toHex(randomBytes(RUN_KEY_RANDOM_BYTES))}`;
