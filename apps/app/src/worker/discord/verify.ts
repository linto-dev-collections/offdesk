export type SignatureVerdict = "ok" | "invalid" | "unconfigured";

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
}): Promise<SignatureVerdict> => {
  const publicKeyHex = input.publicKey?.trim() ?? "";
  if (publicKeyHex === "") return "unconfigured";

  const publicKey = hexToBytes(publicKeyHex);
  if (publicKey === null) return "unconfigured";

  if (input.signature === undefined || input.timestamp === undefined) {
    return "invalid";
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
