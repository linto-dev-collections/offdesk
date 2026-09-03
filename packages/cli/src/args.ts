/**
 * `pnpm run x -- --flag` は **`--` ごと argv に載る**。そのまま `parseArgs` に渡すと
 * `--` で解析が打ち切られてフラグが黙って無視される（kanata で 2 回踏んだ形）。
 *
 * **黙って無視されるのが最悪。** `--dry-run` を付けたつもりで本番へ送ってしまう。
 */
export const cliArgv = (): string[] =>
  process.argv.slice(2).filter((arg) => arg !== "--");

/** 綴りを間違えたフラグは位置引数として残る。**黙って無視せず落とす。** */
export const assertNoPositionals = (positionals: readonly string[]): void => {
  if (positionals.length > 0) {
    throw new Error(`知らない引数です: ${positionals.join(" ")}`);
  }
};

/** 例外を 1 行にして落とす（スタックを人に見せない）。 */
export const runCli = async (main: () => Promise<void>): Promise<void> => {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
};
