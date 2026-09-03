export type FireTokenCipherPort = {
  readonly encrypt: (plaintext: string) => Promise<{
    readonly ciphertext: Uint8Array;
    readonly iv: Uint8Array;
    readonly keyVersion: number;
    readonly last4: string;
  }>;
};

export type ProjectStoreWritePort = {
  readonly upsert: (
    input: {
      readonly name: string;
      readonly discordChannelId: string;
      readonly repoUrl: string;
      readonly fireUrl: string;
      readonly contextWindowTokens: number;
    },
    encrypted: {
      readonly ciphertext: Uint8Array;
      readonly iv: Uint8Array;
      readonly keyVersion: number;
      readonly last4: string;
    },
  ) => Promise<{ readonly projectId: string; readonly inserted: boolean }>;
};

export type SyncProjectsEntry = {
  readonly name: string;
  readonly discordChannelId: string;
  readonly repoUrl: string;
  readonly fireUrl: string;
  readonly fireToken: string;
  readonly contextWindowTokens: number;
};

export type SyncProjectsApplied = {
  readonly name: string;
  readonly inserted: boolean;
  readonly fireTokenLast4: string;
};

/**
 * プロジェクトを投入する（要件 `F-H1`・`F-H3`）。
 *
 * **平文の `fireToken` はこの関数の引数より外へ出ない。** `encrypt` に渡した後は
 * 暗号文だけを持ち回り、戻り値には末尾 4 文字しか載せない（脅威 3・12）。
 */
export const syncProjects = async (
  deps: {
    readonly cipher: FireTokenCipherPort;
    readonly store: ProjectStoreWritePort;
  },
  entries: readonly SyncProjectsEntry[],
): Promise<readonly SyncProjectsApplied[]> => {
  const applied: SyncProjectsApplied[] = [];

  for (const entry of entries) {
    const encrypted = await deps.cipher.encrypt(entry.fireToken);
    const { inserted } = await deps.store.upsert(
      {
        name: entry.name,
        discordChannelId: entry.discordChannelId,
        repoUrl: entry.repoUrl,
        fireUrl: entry.fireUrl,
        contextWindowTokens: entry.contextWindowTokens,
      },
      encrypted,
    );
    applied.push({
      name: entry.name,
      inserted,
      fireTokenLast4: encrypted.last4,
    });
  }

  return applied;
};
