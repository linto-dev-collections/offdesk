export const assertNever = (value: never): never => {
  throw new Error(`到達しないはずの分岐に来ました: ${JSON.stringify(value)}`);
};
